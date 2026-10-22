import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { ATTENDED_ENV, CONTAINER_ENV, type HookPayload, hookDecision, OWNER_PID_ENV, parsePayload, runHook, SESSION_END, USER_PROMPT_SUBMIT } from "./hook.js";
import { COMPACTION_THRESHOLD, claimPath, recordLine, registryPath, type SessionRecord } from "./registry.js";

const HOME = "/home/dev";
const REGISTRY = registryPath({ HOME })!;
const ATTENDED = { [ATTENDED_ENV]: "1", [OWNER_PID_ENV]: "900" };

const HOST = "workstation";

const payload = (over: Partial<HookPayload> = {}): HookPayload => ({ session_id: "s1", cwd: "/work", ...over });
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s1",
  cwd: "/work",
  state: "open",
  at: 10,
  pid: 900,
  host: HOST,
  ...over
});

const decide = (over: Partial<Parameters<typeof hookDecision>[0]> = {}) =>
  hookDecision({ event: USER_PROMPT_SUBMIT, payload: payload(), env: ATTENDED, host: HOST, now: FIXED_NOW, records: [], ...over });

describe("hookDecision", () => {
  it("should register the first prompt a human submitted", () => {
    // Act
    const outcome = decide();

    // Assert
    expect(outcome).toEqual({
      action: "register",
      reason: "a human drove this session for the first time",
      record: { sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST }
    });
  });

  it("should keep the display name hai read off the argv, no payload carrying it", () => {
    // Act / Assert
    expect(decide({ name: "pcs" })).toMatchObject({ action: "register", record: { name: "pcs" } });
  });

  it("should register a session whose owning pid it could not read, liveness then refusing to guess", () => {
    // Act / Assert
    expect(decide({ env: { [ATTENDED_ENV]: "1" } })).toMatchObject({ action: "register", record: { pid: 0 } });
  });

  /**
   * A pid means nothing outside its own PID namespace, and container mode passes no
   * `--pid=host`: without these the `hair` on the host would read a container's pid as if
   * it were one of its own.
   */
  it("should record the namespace the pid is meaningful in", () => {
    // Act
    const outcome = decide({ env: { ...ATTENDED, [CONTAINER_ENV]: "hai-pcs-123" }, host: "a1b2c3" });

    // Assert
    expect(outcome).toMatchObject({ action: "register", record: { host: "a1b2c3", container: "hai-pcs-123" } });
  });

  it("should carry no container field at all for a session that is not in one hai started", () => {
    // Act
    const outcome = decide();

    // Assert
    expect(outcome.action).toBe("register");
    expect(Object.keys((outcome as { record: SessionRecord }).record)).not.toContain("container");
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["a -p run, measured at 0", { [ATTENDED_ENV]: "0" }],
    ["a --bg session, measured at 0 while its entrypoint still reads cli", { [ATTENDED_ENV]: "0" }],
    ["a claude that never set the variable", {}]
  ])("should ignore %s", (_name, env) => {
    // Act / Assert
    expect(decide({ env })).toEqual({ action: "ignore", reason: `${ATTENDED_ENV} is not 1, so nobody is sitting in front of this session` });
  });

  it("should ignore every prompt after the first, including a subagent handing its report back", () => {
    // Act / Assert
    expect(decide({ records: [record()] })).toEqual({ action: "ignore", reason: "the session is already registered" });
  });

  it.each<[string, Partial<SessionRecord>]>([
    ["a new process, which is what a restored session is", { pid: 1 }],
    ["a different directory", { cwd: "/elsewhere" }],
    ["a tombstone, the id having been reopened", { state: "closed" }]
  ])("should re-register a session that moved to %s", (_name, over) => {
    // Act / Assert
    expect(decide({ records: [record(over)] })).toMatchObject({ action: "register" });
  });

  it("should deregister on SessionEnd, which is the half a reboot cannot do", () => {
    // Act
    const outcome = decide({ event: SESSION_END, payload: payload({ reason: "prompt_input_exit" }) });

    // Assert
    expect(outcome).toEqual({
      action: "deregister",
      reason: "the session ended (prompt_input_exit)",
      record: { sessionId: "s1", cwd: "/work", state: "closed", at: FIXED_NOW, pid: 0 }
    });
  });

  it("should deregister a /clear too, that id no longer being a conversation to pick up", () => {
    // Act / Assert
    expect(decide({ event: SESSION_END, payload: payload({ reason: "clear" }) })).toMatchObject({ action: "deregister" });
  });

  it("should deregister even when claude sent no reason", () => {
    // Act / Assert
    expect(decide({ event: SESSION_END })).toMatchObject({ action: "deregister", reason: "the session ended (no reason given)" });
  });

  it.each<[string, HookPayload | null]>([
    ["no payload at all", null],
    ["a payload with no session id", { cwd: "/work" }],
    ["a payload with an empty session id", { session_id: "", cwd: "/work" }],
    ["a payload with no cwd, which hair would have nowhere to resume from", { session_id: "s1" }]
  ])("should ignore %s", (_name, given) => {
    // Act / Assert
    expect(decide({ payload: given })).toEqual({ action: "ignore", reason: "the payload carried no session" });
  });

  it.each<[string, string]>([
    ["an event hair does not maintain the registry from", "SessionStart"],
    ["no event at all", ""]
  ])("should ignore %s", (_name, event) => {
    // Act / Assert
    expect(decide({ event })).toMatchObject({ action: "ignore" });
  });

  it("should name the event it declined, and say so for a missing one", () => {
    // Act / Assert
    expect(decide({ event: "SessionStart" }).reason).toContain("SessionStart is not an event");
    expect(decide({ event: "" }).reason).toContain("no event is not an event");
  });
});

describe("parsePayload", () => {
  it.each<[string, string]>([
    ["nothing on stdin at all", ""],
    ["half a payload", '{"session_id"'],
    ["a JSON array", "[]"],
    ["a JSON null", "null"]
  ])("should read %s as no payload", (_name, text) => {
    // Act / Assert
    expect(parsePayload(text)).toBeNull();
  });
});

describe("runHook", () => {
  const seamsIn = (over: Parameters<typeof createFakeSeams>[0] = {}) =>
    createFakeSeams({ env: { HOME, ...ATTENDED }, stdinText: JSON.stringify(payload()), ...over });

  it("should append the registration to ~/.claude/sessions.jsonl", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT, name: "pcs" });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine({ sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, name: "pcs", host: HOST }));
  });

  it("should append a tombstone and release the claim when the session ends", async () => {
    // Arrange
    const seams = seamsIn({
      stdinText: JSON.stringify(payload({ reason: "prompt_input_exit" })),
      files: { [REGISTRY]: recordLine(record()), [claimPath({ HOME }, "s1")!]: "{}" }
    });

    // Act
    await runHook(seams, { event: SESSION_END });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toContain('"state":"closed"');
    expect(seams.fs.store.has(claimPath({ HOME }, "s1")!)).toBe(false);
  });

  it("should write nothing for a decision to ignore", async () => {
    // Arrange
    const seams = seamsIn({ env: { HOME, [ATTENDED_ENV]: "0" } });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT });

    // Assert
    expect(seams.fs.store.size).toBe(0);
  });

  it("should rewrite the registry once it has grown long, rather than let it grow for ever", async () => {
    // Arrange
    const old = Array.from({ length: COMPACTION_THRESHOLD }, (_, index) => recordLine(record({ sessionId: `old-${index}`, state: "closed" }))).join("");
    const seams = seamsIn({ files: { [REGISTRY]: old } });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine({ sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST }));
  });

  it("should exit quietly when anything at all goes wrong, a hook never being what breaks a session", async () => {
    // Arrange
    const seams = seamsIn({ env: { HOME, HAI_VERBOSE: "1", ...ATTENDED } });
    seams.fs.appendText = async () => {
      throw new Error("the disk is full");
    };

    // Act / Assert
    await expect(runHook(seams, { event: USER_PROMPT_SUBMIT })).resolves.toBeUndefined();
    expect(seams.lines.join("")).toContain("did nothing: the disk is full");
  });

  it("should survive a stdin that rejects rather than a payload that is wrong", async () => {
    // Arrange
    const seams = seamsIn({
      env: { HOME, HAI_VERBOSE: "1", ...ATTENDED },
      stdin: async () => {
        throw "a string nobody wrapped in an Error";
      }
    });

    // Act / Assert
    await expect(runHook(seams, { event: USER_PROMPT_SUBMIT })).resolves.toBeUndefined();
    expect(seams.lines.join("")).toContain("a string nobody wrapped in an Error");
  });
});
