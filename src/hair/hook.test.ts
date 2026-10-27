import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import {
  ACTIVITY_REFRESH_MS,
  ATTENDED_ENV,
  CONTAINER_ENV,
  CONVERSATION_OVER_REASONS,
  type HookOutcome,
  type HookPayload,
  hookDecision,
  OWNER_PID_ENV,
  parsePayload,
  runHook,
  SESSION_END,
  USER_PROMPT_SUBMIT
} from "./hook.js";
import { COMPACTION_THRESHOLD, claimPath, parseRegistry, RESTORE_WINDOW_MS, recordLine, registryPath, type SessionRecord } from "./registry.js";
import { restoreDecision } from "./restore.js";
import { transcriptPath } from "./title.js";

const HOME = "/home/dev";
const REGISTRY = registryPath({ HOME })!;
const ATTENDED = { [ATTENDED_ENV]: "1", [OWNER_PID_ENV]: "900" };
/** Where Claude Code filed this conversation, which is where its name is kept. */
const SLUG = "-filed-here";
/** What Claude Code hands every hook, and the only authoritative statement of the slug. */
const TRANSCRIPT = transcriptPath(`${HOME}/.claude/projects/${SLUG}`, "s1");

/**
 * A transcript holding a name, laid out for the hook to find and never read: it is there so
 * the "reads nothing but the registry" test would fail if the hook went looking.
 */
const named = (title: string) => `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: "s1" })}\n`;

const HOST = "workstation";

const payload = (over: Partial<HookPayload> = {}): HookPayload => ({ session_id: "s1", cwd: "/work", transcript_path: TRANSCRIPT, ...over });
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s1",
  cwd: "/work",
  state: "open",
  at: FIXED_NOW,
  pid: 900,
  host: HOST,
  // Last, so a `recordLine` of this matches what `registration` serialises byte for byte.
  slug: SLUG,
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
      record: { sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST, slug: SLUG }
    });
  });

  /**
   * `parsePayload` establishes only that the payload is a non-array object, so every field on
   * it is unverified — and `path.dirname` throws a `TypeError` on a non-string. A throw here
   * is a throw inside `hookDecision`, which `runHook`'s catch-all turns into the loss of the
   * **whole registration** for that session rather than just the slug. `hookDecision` is
   * non-throwing over any JSON object, and the record comes back without a `slug` the same
   * way one whose payload carried no `transcript_path` does.
   */
  it.each<[string, unknown]>([
    ["a number", 42],
    ["a null", null],
    ["an object", { path: TRANSCRIPT }],
    ["an array", [TRANSCRIPT]]
  ])("should register the session, less the slug, when transcript_path is %s", (_name, path) => {
    // Act
    const outcome = decide({ payload: { ...payload(), transcript_path: path as string } });

    // Assert
    expect(outcome).toEqual({
      action: "register",
      reason: "a human drove this session for the first time",
      record: { sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST }
    });
  });

  /**
   * The argv is the only name the hook has, and the only one it needs: `resolveName`
   * re-reads the transcript at restore time and overwrites this, so the record's value is
   * the fallback for a conversation whose transcript is not there to be read.
   */
  it("should keep the display name hai read off the argv, no payload carrying it", () => {
    // Act / Assert
    expect(decide({ name: "pcs" })).toMatchObject({ action: "register", record: { name: "pcs" } });
  });

  /**
   * Recorded so the restore can find the transcript by one `stat` rather than by scanning
   * every project directory. Taken out of the payload rather than computed: Claude Code
   * fixes the slug at startup and `cwd` does not have to agree with it.
   */
  it("should record the slug out of the payload's transcript path, not one derived from cwd", () => {
    // Act
    const outcome = decide({ payload: payload({ cwd: "/a-worktree-it-cd-ed-into" }) });

    // Assert
    expect(outcome).toMatchObject({ action: "register", record: { cwd: "/a-worktree-it-cd-ed-into", slug: SLUG } });
  });

  it("should carry no slug at all when the payload gave no transcript path to take one from", () => {
    // Act
    const outcome = decide({ payload: { session_id: "s1", cwd: "/work" } });

    // Assert
    expect(outcome.action).toBe("register");
    expect(Object.keys((outcome as { record: SessionRecord }).record)).not.toContain("slug");
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
    expect(decide({ records: [record()] })).toEqual({ action: "ignore", reason: "the session is already registered and was active recently enough" });
  });

  /**
   * `at` is last activity, not registration time, because the candidate order is by
   * recency: a conversation registered at 09:00 and worked in all day has to outrank one
   * registered at 16:30 and left idle. Throttled to `ACTIVITY_REFRESH_MS`, because a line
   * per prompt is what `COMPACTION_THRESHOLD` would have to absorb.
   */
  it.each<[string, number, HookOutcome["action"]]>([
    ["within the interval", ACTIVITY_REFRESH_MS - 1, "ignore"],
    ["exactly at the interval", ACTIVITY_REFRESH_MS, "register"],
    ["well past the interval", 4 * ACTIVITY_REFRESH_MS, "register"]
  ])("should restamp a still-driven session whose last activity was %s", (_name, elapsed, action) => {
    // Act / Assert
    expect(decide({ records: [record({ at: FIXED_NOW - elapsed })] })).toMatchObject({ action });
  });

  it("should move the record's last-active time on and change nothing else about it", () => {
    // Act
    const outcome = decide({ name: "pcs", records: [record({ at: FIXED_NOW - ACTIVITY_REFRESH_MS, name: "pcs" })] });

    // Assert
    expect(outcome).toEqual({
      action: "register",
      reason: "the session is still being driven, so when it was last active moves on",
      record: { sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, name: "pcs", host: HOST, slug: SLUG }
    });
  });

  it.each<[string, Partial<SessionRecord>]>([
    ["a new process, which is what a restored session is", { pid: 1 }],
    ["a different directory", { cwd: "/elsewhere" }],
    ["a tombstone, the id having been reopened", { state: "closed" }]
  ])("should re-register a session that moved to %s", (_name, over) => {
    // Act / Assert
    expect(decide({ records: [record(over)] })).toMatchObject({ action: "register" });
  });

  it("should deregister on SessionEnd, which is the half a kill cannot do", () => {
    // Act
    const outcome = decide({ event: SESSION_END, payload: payload({ reason: "prompt_input_exit" }) });

    // Assert
    expect(outcome).toEqual({
      action: "deregister",
      reason: "the person ended the conversation (prompt_input_exit)",
      record: { sessionId: "s1", cwd: "/work", state: "closed", at: FIXED_NOW, pid: 0 }
    });
  });

  /**
   * Every reason the enum holds, one row each, because the choice between these verdicts
   * *is* the mechanism and a single example cannot tell "every reason deregisters" from
   * "only the ones that mean the conversation is over do". Measured on Claude Code
   * 2.1.304: `SessionEnd` fires on a SIGTERM too, reporting `other`, so deregistering on
   * every reason closed the record of every session a devcontainer shutdown killed —
   * precisely the set `hair` exists to hand back. The sixth row stands in for a reason a
   * later version adds, which must stay restorable until somebody measures it.
   */
  it.each<[string, string | undefined, HookOutcome["action"]]>([
    ["/exit", "prompt_input_exit", "deregister"],
    ["/clear, that id no longer being a conversation to pick up", "clear", "deregister"],
    ["/logout, which ends a session over credentials and leaves the conversation resumable", "logout", "interrupted"],
    ["a SIGTERM, which is how closing the editor ends a devcontainer session", "other", "interrupted"],
    ["an interactive /resume, which leaves a conversation rather than ending it", "resume", "interrupted"],
    ["a reason a later claude sent that nobody here has measured", "a-reason-from-a-later-claude", "interrupted"],
    ["no reason at all", undefined, "interrupted"]
  ])("should decide a session that ended on %s", (_name, reason, action) => {
    // Act / Assert
    expect(decide({ event: SESSION_END, payload: payload(reason === undefined ? {} : { reason }) })).toMatchObject({ action });
  });

  /**
   * The tempting argument, written down so it is not made again: signing out is
   * deliberate, therefore it must be the person ending the session. It is deliberate about
   * *credentials*. The conversation is untouched and resumable, so tombstoning it loses it
   * for someone who logs out and straight back in. Deliberateness is not the test.
   */
  it("should keep the entry of a session that ended on /logout, the conversation being untouched by signing out", () => {
    // Act / Assert
    expect(CONVERSATION_OVER_REASONS).not.toContain("logout");
    expect(decide({ event: SESSION_END, payload: payload({ reason: "logout" }) })).toMatchObject({ action: "interrupted" });
  });

  it("should carry the session id on an interrupted end, there being no record to write and a claim to release", () => {
    // Act / Assert
    expect(decide({ event: SESSION_END, payload: payload({ reason: "other" }) })).toMatchObject({ action: "interrupted", sessionId: "s1" });
  });

  it("should say why a terminated session keeps its entry, that line being the only trace in a hook's log", () => {
    // Act / Assert
    expect(decide({ event: SESSION_END, payload: payload({ reason: "other" }) }).reason).toBe(
      "the session ended with other, which is also what a terminated session reports, so its entry stays restorable"
    );
    expect(decide({ event: SESSION_END }).reason).toContain("no reason given");
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
    expect(seams.fs.store.get(REGISTRY)).toBe(
      recordLine({ sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, name: "pcs", host: HOST, slug: SLUG })
    );
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

  /**
   * The bug this file is the regression test for: closing the editor stops the
   * devcontainer, every session gets a SIGTERM, each one's `SessionEnd` fires with
   * `other`, and the tombstone that used to append left `hair --list` reporting "the
   * session was closed cleanly" about every conversation the engineer had open.
   */
  it("should leave the record open when a session was terminated, so hair can still hand it back", async () => {
    // Arrange
    const seams = seamsIn({ stdinText: JSON.stringify(payload({ reason: "other" })), files: { [REGISTRY]: recordLine(record()) } });

    // Act
    await runHook(seams, { event: SESSION_END });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine(record()));
    expect(restoreDecision({ record: parseRegistry(seams.fs.store.get(REGISTRY)!)[0]!, now: FIXED_NOW, cwdExists: true, alive: false })).toMatchObject({
      action: "restore"
    });
  });

  it("should release the claim of a terminated session, so the next terminal needs no pid read to be offered it", async () => {
    // Arrange
    const seams = seamsIn({
      stdinText: JSON.stringify(payload({ reason: "other" })),
      files: { [REGISTRY]: recordLine(record()), [claimPath({ HOME }, "s1")!]: "{}" }
    });

    // Act
    await runHook(seams, { event: SESSION_END });

    // Assert
    expect(seams.fs.store.has(claimPath({ HOME }, "s1")!)).toBe(false);
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine(record()));
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
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine({ sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST, slug: SLUG }));
  });

  /**
   * The case the length test alone could not see. With open records permanent, a registry
   * whose *open* set is past the threshold can never be shrunk by a rewrite, so
   * `lines >= COMPACTION_THRESHOLD` stays true and the one operation that can lose a
   * concurrent append would fire on every register and every deregister for ever. Here the
   * registry is long and entirely open and recent: the hook must append its line and leave
   * the file alone.
   */
  it("should not rewrite a long registry whose records are all still open, that being every hook from then on", async () => {
    // Arrange
    const open = Array.from({ length: COMPACTION_THRESHOLD }, (_, index) => recordLine(record({ sessionId: `open-${index}`, pid: 100 + index }))).join("");
    const seams = seamsIn({ files: { [REGISTRY]: open } });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(
      `${open}${recordLine({ sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST, slug: SLUG })}`
    );
    expect([...seams.fs.store.keys()].filter((key) => key.endsWith(".tmp"))).toEqual([]);
  });

  it("should drop the records nothing has touched inside the window when it does rewrite", async () => {
    // Arrange
    const stale = Array.from({ length: COMPACTION_THRESHOLD }, (_, index) =>
      recordLine(record({ sessionId: `stale-${index}`, at: FIXED_NOW - RESTORE_WINDOW_MS - 1 }))
    ).join("");
    const seams = seamsIn({ files: { [REGISTRY]: stale } });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine({ sessionId: "s1", cwd: "/work", state: "open", at: FIXED_NOW, pid: 900, host: HOST, slug: SLUG }));
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

  /**
   * **The registry file is the only thing a hook reads, and this is the test that keeps it
   * that way.** Reading the conversation's title here cost a full transcript scan on every
   * prompt — 402 ms measured on a 198 MB conversation, and the fifteen-minute throttle is no
   * protection because the read happened before the decision that ignores the prompt. It
   * bought nothing: `resolveName` re-reads the transcript at restore time and overwrites
   * whatever the registry held. Both rows go through `registration`, so neither the first
   * prompt nor a later one may touch a transcript.
   */
  it.each<[string, Record<string, string>]>([
    ["a first prompt", {}],
    ["a prompt in a session already registered and recently active", { [REGISTRY]: recordLine(record()) }]
  ])("should read nothing but the registry for %s", async (_name, files) => {
    // Arrange
    const seams = seamsIn({ files: { ...files, [TRANSCRIPT]: named("hai-resume") } });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT, name: "pcs" });

    // Assert
    expect(seams.fs.reads).toEqual([REGISTRY]);
  });

  it("should write nothing more for a prompt in a session that is already registered", async () => {
    // Arrange
    const unchanged = recordLine(record({ name: "pcs" }));
    const seams = seamsIn({ files: { [REGISTRY]: unchanged, [TRANSCRIPT]: named("hai-resume") } });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT, name: "pcs" });

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(unchanged);
  });

  /**
   * The slug goes in even though no name does: it is `resolveName`'s fast path to the
   * transcript at restore time, which is why the hook wants the payload's `transcript_path`
   * at all. The session here has `cd`-ed away from where Claude Code filed it.
   */
  it("should record the slug for a session whose cwd has moved away from it", async () => {
    // Arrange
    const seams = seamsIn({ stdinText: JSON.stringify(payload({ cwd: "/a-worktree-it-cd-ed-into" })) });

    // Act
    await runHook(seams, { event: USER_PROMPT_SUBMIT });

    // Assert
    expect(parseRegistry(seams.fs.store.get(REGISTRY)!)).toEqual([record({ cwd: "/a-worktree-it-cd-ed-into" })]);
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
