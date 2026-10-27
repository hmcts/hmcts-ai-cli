import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW, type RunResponder } from "../__fixtures__/fake-seams.js";
import type { SessionRecord } from "./registry.js";
import { describeCandidate, livenessPlan, probeDirs, probeLiveness, resolveNames, restoreCandidates, restoreDecision } from "./restore.js";
import { customTitlePath } from "./title.js";

const HOST = "workstation";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "a",
  cwd: "/work",
  state: "open",
  at: FIXED_NOW,
  pid: 100,
  host: HOST,
  ...over
});

const decide = (over: Partial<Parameters<typeof restoreDecision>[0]> = {}) =>
  restoreDecision({ record: record(), now: FIXED_NOW, cwdExists: true, alive: false, ...over });

describe("restoreDecision", () => {
  it.each<[string, Partial<Parameters<typeof restoreDecision>[0]>, "restore" | "skip"]>([
    ["an open session whose process is gone", {}, "restore"],
    ["an open session whose process is still there", { alive: true }, "skip"],
    ["an open session whose process cannot be asked about", { alive: null }, "skip"],
    ["a session that was closed cleanly", { record: record({ state: "closed" }) }, "skip"],
    ["a session whose directory has been deleted since", { cwdExists: false }, "skip"],
    ["an open session still inside the window", { record: record({ at: FIXED_NOW - 6 * DAY }) }, "restore"],
    ["an open session nothing has touched for longer than the window", { record: record({ at: FIXED_NOW - 8 * DAY }) }, "skip"]
  ])("should %s", (_name, over, action) => {
    // Act / Assert
    expect(decide(over).action).toBe(action);
  });

  it("should say why a live session is left alone, because it would be forked rather than resumed", () => {
    // Act / Assert
    expect(decide({ alive: true }).reason).toBe("pid 100 is still running, so the session is live");
  });

  it("should refuse to guess about a pid it could not ask about, as the transcript lock does", () => {
    // Act / Assert
    expect(decide({ alive: null }).reason).toContain("cannot be told");
  });

  /**
   * Ahead of the probes, because that is the point of it: a retired record costs no `ps`
   * and no `stat`. It is decided before liveness and before the directory check, so the
   * `false`/`null` the probes never gathered for it cannot be read as an answer.
   */
  it("should retire an untouched record ahead of the probes, saying how long it has been", () => {
    // Act / Assert
    expect(decide({ record: record({ at: FIXED_NOW - 21 * DAY }), cwdExists: false, alive: true }).reason).toBe(
      "nothing has touched it for 21 days, so it is not a conversation to hand back"
    );
  });

  /**
   * `process.chdir` throws, and the claim is taken first, so a record pointing at a
   * deleted worktree would end `hair` with the claim held and the next run would reclaim
   * it and fail again — for every conversation, until the registry was hand-edited.
   */
  it("should decide a missing directory before liveness, rather than let the chdir throw later", () => {
    // Act / Assert
    expect(decide({ cwdExists: false, alive: false }).reason).toBe("its directory /work is gone, so there is nowhere to resume it");
  });
});

describe("restoreCandidates", () => {
  const all = (records: SessionRecord[], over: Partial<Parameters<typeof restoreCandidates>[0]> = {}) =>
    restoreCandidates({
      records,
      cwd: "/work",
      now: FIXED_NOW,
      liveness: new Map(records.map((r) => [r.sessionId, false as boolean | null])),
      existingDirs: new Set(records.map((r) => r.cwd)),
      ...over
    });

  it("should prefer this directory and then take the most recent, cwd being a preference and not a filter", () => {
    // Arrange
    const records = [
      record({ sessionId: "elsewhere-new", cwd: "/other", at: FIXED_NOW - 10 * MINUTE }),
      record({ sessionId: "here-new", cwd: "/work", at: FIXED_NOW - 20 * MINUTE }),
      record({ sessionId: "elsewhere-old", cwd: "/other", at: FIXED_NOW - 40 * MINUTE }),
      record({ sessionId: "here-old", cwd: "/work", at: FIXED_NOW - 30 * MINUTE })
    ];

    // Act
    const { candidates } = all(records);

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["here-new", "here-old", "elsewhere-new", "elsewhere-old"]);
  });

  /**
   * One directory, so nothing but `at` decides, which is what tells newest-first from the
   * oldest-first this used to do. Nothing retires an open record — a conversation stepped
   * out of with `/resume` stays open until `RESTORE_WINDOW_MS` retires it, so the pile
   * holds a week of them. Oldest-first handed an engineer with three tabs the three oldest
   * things in it and left the three they had actually been in waiting behind them.
   */
  it("should hand back the conversation that was live most recently, the stale ones sinking to the bottom", () => {
    // Arrange
    const records = [
      record({ sessionId: "six-days-ago", at: FIXED_NOW - 6 * DAY }),
      record({ sessionId: "an-hour-ago", at: FIXED_NOW - 60 * MINUTE }),
      record({ sessionId: "two-days-ago", at: FIXED_NOW - 2 * DAY })
    ];

    // Act
    const { candidates } = all(records);

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["an-hour-ago", "two-days-ago", "six-days-ago"]);
  });

  it("should break a tie on the id, so two terminals walk the candidates in the same order", () => {
    // Arrange
    const records = [record({ sessionId: "b" }), record({ sessionId: "a" })];

    // Act
    const { candidates } = all(records);

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["a", "b"]);
  });

  it("should report what it skipped and why", () => {
    // Arrange
    const records = [record({ sessionId: "live" }), record({ sessionId: "dead" })];

    // Act
    const { candidates, skipped } = all(records, {
      liveness: new Map<string, boolean | null>([
        ["live", true],
        ["dead", false]
      ])
    });

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["dead"]);
    expect(skipped).toEqual([{ record: record({ sessionId: "live" }), reason: "pid 100 is still running, so the session is live" }]);
  });

  it("should treat a session it has no liveness answer for as unanswerable", () => {
    // Act / Assert
    expect(all([record()], { liveness: new Map() }).candidates).toEqual([]);
  });

  it("should offer nothing for a record whose directory is not in the set", () => {
    // Act / Assert
    expect(all([record()], { existingDirs: new Set() }).candidates).toEqual([]);
  });
});

describe("describeCandidate", () => {
  it.each<[string, Partial<SessionRecord>, string, string]>([
    ["this directory by name", {}, "/work", "a  (unnamed)  this directory"],
    ["another directory in full", { cwd: "/other", name: "pcs" }, "/work", "a  pcs  /other"]
  ])("should describe %s", (_name, over, cwd, expected) => {
    // Act / Assert
    expect(describeCandidate(record(over), cwd)).toBe(expected);
  });
});

/**
 * A pid only means something in its own PID namespace, and the hook that records one
 * routinely runs in a different one from the `hair` that reads it: container mode passes
 * no `--pid=host`.
 */
describe("livenessPlan", () => {
  it.each<[string, Partial<SessionRecord>, string | undefined, "pid" | "container" | "none"]>([
    ["ask ps when the record was written where we are standing", {}, HOST, "pid"],
    ["ask docker when the pid belongs to a hai container", { host: "a1b2c3", container: "hai-pcs-123" }, HOST, "container"],
    ["ask nothing when the hosts differ and no container is named", { host: "a1b2c3" }, HOST, "none"],
    ["ask nothing when the record names no host at all", { host: undefined }, HOST, "none"],
    ["ask nothing when we do not know our own host", {}, undefined, "none"],
    ["ask nothing about a registration with no pid", { pid: 0 }, HOST, "none"],
    ["prefer ps over docker when the container is this one", { host: HOST, container: "hai-pcs-123" }, HOST, "pid"]
  ])("should %s", (_name, over, host, probe) => {
    // Act / Assert
    expect(livenessPlan({ record: record(over), host }).probe).toBe(probe);
  });

  it("should say which namespace it could not compare against", () => {
    // Act / Assert
    expect(livenessPlan({ record: record({ host: "a1b2c3" }), host: HOST }).reason).toBe(
      "pid 100 was recorded on a1b2c3, which cannot be compared with this one"
    );
    expect(livenessPlan({ record: record({ host: undefined }), host: HOST }).reason).toContain("an unnamed host");
  });
});

describe("probeLiveness", () => {
  const seamsFor = (respond: RunResponder) => createFakeSeams({ respond });

  it.each<[string, number, string, boolean | null]>([
    ["a pid that is still there", 0, "42\n", true],
    ["a pid that is gone", 1, "", false],
    ["a machine with no ps on it, which is not grounds to resume anything", 127, "", null]
  ])("should read %s", async (_name, code, stdout, expected) => {
    // Arrange
    const seams = seamsFor((argv) => (argv[0] === "ps" ? { code, stdout } : undefined));

    // Act
    const liveness = await probeLiveness({ ...seams, host: HOST, now: FIXED_NOW }, [record({ pid: 42 })]);

    // Assert
    expect(seams.runner.calls[0]?.argv).toEqual(["ps", "-p", "42", "-o", "pid="]);
    expect(liveness.get("a")).toBe(expected);
  });

  /**
   * Pid 0 cannot be `false`. "No pid recorded" is not "no process": the session may be
   * the very one running in this terminal, and calling it dead would let a second `hair`
   * claim it and fork the conversation.
   */
  it("should treat a registration with no pid as unanswerable rather than as gone", async () => {
    // Arrange
    const seams = seamsFor(() => undefined);

    // Act
    const liveness = await probeLiveness({ ...seams, host: HOST, now: FIXED_NOW }, [record({ pid: 0 })]);

    // Assert
    expect(seams.runner.calls).toEqual([]);
    expect(liveness.get("a")).toBeNull();
  });

  it.each<[string, number, string, boolean | null]>([
    ["gone, which is what a reboot leaves behind", 1, "Error: No such object: hai-pcs-123", false],
    ["still up, which is not grounds to resume it", 0, "", null]
  ])("should read a container that is %s", async (_name, code, stderr, expected) => {
    // Arrange
    const seams = seamsFor((argv) => (argv[0] === "docker" ? { code, stderr, stdout: code === 0 ? "true\n" : "" } : undefined));

    // Act
    const liveness = await probeLiveness({ ...seams, host: HOST, now: FIXED_NOW }, [record({ host: "a1b2c3", container: "hai-pcs-123" })]);

    // Assert
    expect(seams.runner.calls[0]?.argv).toEqual(["docker", "inspect", "-f", "{{.State.Running}}", "hai-pcs-123"]);
    expect(liveness.get("a")).toBe(expected);
  });

  it("should read a docker that cannot answer as unanswerable, not as a dead container", async () => {
    // Arrange
    const seams = seamsFor((argv) => (argv[0] === "docker" ? { code: 127, stderr: "docker: not found" } : undefined));

    // Act
    const liveness = await probeLiveness({ ...seams, host: HOST, now: FIXED_NOW }, [record({ host: "a1b2c3", container: "hai-pcs-123" })]);

    // Assert
    expect(liveness.get("a")).toBeNull();
  });

  it("should ask nothing about the tombstones, whose answers are thrown away anyway", async () => {
    // Arrange
    const seams = seamsFor(() => ({ code: 1 }));

    // Act
    const liveness = await probeLiveness({ ...seams, host: HOST, now: FIXED_NOW }, [record({ sessionId: "closed", state: "closed" })]);

    // Assert
    expect(seams.runner.calls).toEqual([]);
    expect(liveness.size).toBe(0);
  });

  /**
   * The cost that made retirement necessary. Only an allow-listed reason writes a
   * tombstone, so without a window every conversation the engineer has ever had is an open
   * record and each one is a sequential `ps` on every `hair` and every `hair --list`.
   */
  it("should ask nothing about the records the window has retired, which is what bounds the probe", async () => {
    // Arrange
    const seams = seamsFor(() => ({ code: 1 }));

    // Act
    const liveness = await probeLiveness({ ...seams, host: HOST, now: FIXED_NOW }, [
      record({ sessionId: "recent", at: FIXED_NOW - DAY }),
      record({ sessionId: "retired", at: FIXED_NOW - 21 * DAY })
    ]);

    // Assert
    expect(seams.runner.calls).toHaveLength(1);
    expect([...liveness.keys()]).toEqual(["recent"]);
  });
});

describe("probeDirs", () => {
  it("should check each kept record's directory once and leave the tombstones and the retired alone", async () => {
    // Arrange
    const seams = createFakeSeams();
    await seams.fs.mkdirp("/work");
    // Present on disk, so being absent from the answer can only be the window.
    await seams.fs.mkdirp("/retired");

    // Act
    const dirs = await probeDirs({ ...seams, now: FIXED_NOW }, [
      record({ sessionId: "a", cwd: "/work" }),
      record({ sessionId: "b", cwd: "/work" }),
      record({ sessionId: "c", cwd: "/gone" }),
      record({ sessionId: "d", cwd: "/also-gone", state: "closed" }),
      record({ sessionId: "e", cwd: "/retired", at: FIXED_NOW - 21 * DAY })
    ]);

    // Assert
    expect([...dirs]).toEqual(["/work"]);
  });
});

describe("resolveNames", () => {
  const HOME = "/home/dev";
  const titleOf = (slug: string, sessionId: string) => customTitlePath({ HOME }, { slug, sessionId })!;
  const stored = (name: string) => JSON.stringify({ customTitle: name });
  /** The slug `projectSlug` derives from the fixture record's `/work`, so the fallback finds it. */
  const SLUG = "-work";

  /**
   * The registry's `name` is a cache of something Claude Code owns, and it can be up to
   * `ACTIVITY_REFRESH_MS` behind: `/rename` at 16:55 and the container lost at 17:00 leaves
   * the record holding the old name and the file holding the new one. The file is
   * authoritative at the moment the name is wanted.
   */
  it("should prefer the stored title over a record name that disagrees with it", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [titleOf(SLUG, "a")]: stored("the renamed one") } });

    // Act
    const resolved = await resolveNames(seams, [record({ sessionId: "a", name: "the old one" })]);

    // Assert
    expect(resolved).toEqual([record({ sessionId: "a", name: "the renamed one" })]);
  });

  it("should name a conversation the registry never had a name for, which is every record written before this", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [titleOf(SLUG, "a")]: stored("hai-resume") } });

    // Act / Assert
    expect(await resolveNames(seams, [record({ sessionId: "a" })])).toEqual([record({ sessionId: "a", name: "hai-resume" })]);
  });

  /**
   * The fallback is not a formality: it is the `-n/--name` case, where no file was ever
   * written, and the conversation whose title file has been deleted since it was registered.
   */
  it.each<[string, Record<string, string>]>([
    ["no title file exists — either none was written or it has been deleted since", {}],
    ["the title file is half-written", { [titleOf(SLUG, "a")]: '{"customTitle":' }],
    ["the title file holds no usable name", { [titleOf(SLUG, "a")]: "{}" }]
  ])("should fall back to the name the record holds when %s", async (_name, files) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files });

    // Act / Assert
    expect(await resolveNames(seams, [record({ sessionId: "a", name: "pcs" })])).toEqual([record({ sessionId: "a", name: "pcs" })]);
  });

  it("should leave a record with no name anywhere exactly as it was, rather than give it an undefined one", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });
    const unnamed = record({ sessionId: "a" });

    // Act
    const resolved = await resolveNames(seams, [unnamed]);

    // Assert
    expect(resolved[0]).toBe(unnamed);
    expect(Object.keys(resolved[0]!)).not.toContain("name");
  });

  /**
   * Claude Code fixes the slug when the session starts; the record's `cwd` is rewritten
   * whenever the hook sees the session in a new directory. So a conversation that registered
   * at a workspace root and then `cd`-ed into a worktree has a `cwd` that no longer says
   * where its transcripts live, and only the recorded slug still finds the title.
   */
  it("should key on the recorded slug rather than on a cwd that has moved since", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [titleOf(SLUG, "a")]: stored("filed under the old directory") } });

    // Act
    const resolved = await resolveNames(seams, [record({ sessionId: "a", cwd: "/a-worktree-it-cd-ed-into", slug: SLUG })]);

    // Assert
    expect(resolved[0]!.name).toBe("filed under the old directory");
  });

  /**
   * One read per candidate, keyed on that candidate's own directory and id — a name read
   * for the wrong conversation is worse than no name at all. These records carry no slug,
   * so they also exercise the `cwd` fallback the existing registry depends on.
   */
  it("should resolve each candidate against its own title file, in the order it was given", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [titleOf(SLUG, "a")]: stored("the work one"), [titleOf("-other", "b")]: stored("the other one") }
    });

    // Act
    const resolved = await resolveNames(seams, [record({ sessionId: "a", cwd: "/work" }), record({ sessionId: "b", cwd: "/other" })]);

    // Assert
    expect(resolved.map((candidate) => candidate.name)).toEqual(["the work one", "the other one"]);
  });
});
