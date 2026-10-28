import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW, type RunResponder } from "../__fixtures__/fake-seams.js";
import type { SessionRecord } from "./registry.js";
import {
  describeCandidate,
  livenessPlan,
  probeDirs,
  probeLiveness,
  resolveName,
  resolveNames,
  resolveResumeDir,
  restoreCandidates,
  restoreDecision,
  resumeDir
} from "./restore.js";
import { transcriptPath } from "./title.js";

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

  it("should retire an untouched record ahead of the probes, saying how long it has been", () => {
    // Act / Assert
    expect(decide({ record: record({ at: FIXED_NOW - 21 * DAY }), cwdExists: false, alive: true }).reason).toBe(
      "nothing has touched it for 21 days, so it is not a conversation to hand back"
    );
  });

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
  it.each<[string, Partial<SessionRecord>, string, string, string]>([
    ["this directory by name, marked because the record was last used here too", {}, "/work", "/work", "a  (unnamed)  this directory  (last here)"],
    ["another directory in full", { cwd: "/other", name: "pcs" }, "/work", "/other", "a  pcs  /other"],
    [
      "the directory it will resume in rather than the one last seen",
      { cwd: "/work/.claude/worktrees/a-feature", name: "pcs" },
      "/elsewhere",
      "/work",
      "a  pcs  /work"
    ],
    [
      "the resume directory as this one, even though the record's cwd is not",
      { cwd: "/work/.claude/worktrees/a-feature" },
      "/work",
      "/work",
      "a  (unnamed)  this directory"
    ],
    [
      "a record that sorted to the top because it was last used here, resuming elsewhere",
      { cwd: "/work", name: "pcs" },
      "/work",
      "/opened-in",
      "a  pcs  /opened-in  (last here)"
    ]
  ])("should describe %s", (_name, over, cwd, resumeIn, expected) => {
    // Act / Assert
    expect(describeCandidate(record(over), cwd, resumeIn)).toBe(expected);
  });

  it("should tell apart the two records that both resume in this directory, so the ordering is legible", () => {
    // Arrange
    // `rank` sorts the first above the second, and both resume where `hair` is being run.
    const lastHere = record({ sessionId: "ranked-first", cwd: "/work", name: "pcs" });
    const openedHere = record({ sessionId: "ranked-second", cwd: "/work/.claude/worktrees/a-feature", name: "pcs" });

    // Act
    const first = describeCandidate(lastHere, "/work", "/work");
    const second = describeCandidate(openedHere, "/work", "/work");

    // Assert
    expect(first).toBe("ranked-first  pcs  this directory  (last here)");
    expect(second).toBe("ranked-second  pcs  this directory");
    expect(first.endsWith("(last here)")).not.toBe(second.endsWith("(last here)"));
  });
});

describe("resumeDir", () => {
  const OPENED_IN = "/work";
  const MOVED_TO = "/work/.claude/worktrees/a-feature";

  it.each<[string, Parameters<typeof resumeDir>[0], string]>([
    ["the opening directory, which is the one Claude Code fixed the project slug from", { cwd: MOVED_TO, openedIn: OPENED_IN, openingIsDir: true }, OPENED_IN],
    [
      "the record's own cwd when the opening directory is no longer a directory — deleted, or deleted and reused as a file",
      { cwd: MOVED_TO, openedIn: OPENED_IN, openingIsDir: false },
      MOVED_TO
    ],
    ["the record's own cwd when the transcript said nothing about where it was opened", { cwd: MOVED_TO, openedIn: undefined, openingIsDir: false }, MOVED_TO],
    ["the one directory when the session never moved out of it", { cwd: OPENED_IN, openedIn: OPENED_IN, openingIsDir: true }, OPENED_IN]
  ])("should resume in %s", (_name, input, expected) => {
    // Act / Assert
    expect(resumeDir(input)).toBe(expected);
  });
});

describe("resolveResumeDir", () => {
  const OPENED_IN = "/work";
  const MOVED_TO = "/work/.claude/worktrees/a-feature";

  it("should stat the opening directory, which nothing before the claim has checked", async () => {
    // Arrange
    const seams = createFakeSeams();
    await seams.fs.mkdirp(OPENED_IN);

    // Act / Assert
    await expect(resolveResumeDir(seams, { ...record({ cwd: MOVED_TO }), openedIn: OPENED_IN })).resolves.toBe(OPENED_IN);
  });

  it("should fall back to the record's cwd when the opening directory is gone, rather than let the chdir throw", async () => {
    // Arrange
    const seams = createFakeSeams();

    // Act / Assert
    await expect(resolveResumeDir(seams, { ...record({ cwd: MOVED_TO }), openedIn: "/a-deleted-worktree" })).resolves.toBe(MOVED_TO);
  });

  it("should fall back when the opening path is a file, which a bare existence check would have passed", async () => {
    // Arrange
    // A deleted worktree path later reused for something that is not a directory: `stat`
    // succeeds, and a `chdir` onto it throws ENOTDIR.
    const seams = createFakeSeams({ files: { [OPENED_IN]: "not a directory" } });

    // Act / Assert
    await expect(seams.fs.exists(OPENED_IN)).resolves.toBe(true);
    await expect(resolveResumeDir(seams, { ...record({ cwd: MOVED_TO }), openedIn: OPENED_IN })).resolves.toBe(MOVED_TO);
  });

  it("should stat nothing for a record whose transcript named no opening directory", async () => {
    // Arrange
    const seams = createFakeSeams();
    const statted: string[] = [];
    seams.fs.isDirectory = async (path): Promise<boolean> => {
      statted.push(path);
      return true;
    };

    // Act
    const resolved = await resolveResumeDir(seams, record({ cwd: MOVED_TO }));

    // Assert
    expect(resolved).toBe(MOVED_TO);
    expect(statted).toEqual([]);
  });
});

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

describe("resolveName", () => {
  const HOME = "/home/dev";
  const transcriptOf = (slug: string, sessionId: string) => transcriptPath(`${HOME}/.claude/projects/${slug}`, sessionId);
  const named = (name: string) => `${JSON.stringify({ type: "custom-title", customTitle: name })}\n`;
  /** A project directory that is nothing like the fixture record's `/work`, which is the point. */
  const SLUG = "-filed-somewhere-else";

  it("should prefer the title the transcript holds over a record name that disagrees with it", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [transcriptOf(SLUG, "a")]: named("the renamed one") } });

    // Act
    const resolved = await resolveName(seams, record({ sessionId: "a", name: "the old one" }));

    // Assert
    expect(resolved).toEqual(record({ sessionId: "a", name: "the renamed one" }));
  });

  it("should name a conversation the registry never had a name for, which is every record written before this", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [transcriptOf(SLUG, "a")]: named("hai-resume") } });

    // Act / Assert
    expect(await resolveName(seams, record({ sessionId: "a" }))).toEqual(record({ sessionId: "a", name: "hai-resume" }));
  });

  it.each<[string, Record<string, string>]>([
    ["no transcript exists — it has been deleted since the registration", {}],
    ["the transcript carries no title record", { [transcriptOf(SLUG, "a")]: `${JSON.stringify({ type: "user" })}\n` }],
    ["the transcript's title record holds no usable name", { [transcriptOf(SLUG, "a")]: `${JSON.stringify({ type: "custom-title" })}\n` }]
  ])("should fall back to the name the record holds when %s", async (_name, files) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files });

    // Act / Assert
    expect(await resolveName(seams, record({ sessionId: "a", name: "pcs" }))).toEqual(record({ sessionId: "a", name: "pcs" }));
  });

  it("should leave a record the transcript answered nothing about exactly as it was, rather than give it undefined fields", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });
    const unnamed = record({ sessionId: "a" });

    // Act
    const resolved = await resolveName(seams, unnamed);

    // Assert
    expect(resolved).toBe(unnamed);
    expect(Object.keys(resolved)).not.toContain("name");
    expect(Object.keys(resolved)).not.toContain("openedIn");
  });

  it("should carry back the directory the conversation was opened in, out of the same pass", async () => {
    // Arrange
    const openedIn = `${JSON.stringify({ type: "user", cwd: "/work" })}\n`;
    const movedTo = `${JSON.stringify({ type: "user", cwd: "/work/.claude/worktrees/a-feature" })}\n`;
    const seams = createFakeSeams({ env: { HOME }, files: { [transcriptOf(SLUG, "a")]: `${openedIn}${named("pcs")}${movedTo}` } });

    // Act
    const resolved = await resolveName(seams, record({ sessionId: "a", cwd: "/work/.claude/worktrees/a-feature" }));

    // Assert
    expect(resolved.openedIn).toBe("/work");
    // The record's own `cwd` stays "last seen": `probeDirs`, `livenessPlan` and `rank` read it that way.
    expect(resolved.cwd).toBe("/work/.claude/worktrees/a-feature");
    expect(resolved.name).toBe("pcs");
  });

  it("should give a record with an opening directory but no name anywhere no name field", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [transcriptOf(SLUG, "a")]: `${JSON.stringify({ type: "user", cwd: "/work" })}\n` } });

    // Act
    const resolved = await resolveName(seams, record({ sessionId: "a" }));

    // Assert
    expect(resolved.openedIn).toBe("/work");
    expect(Object.keys(resolved)).not.toContain("name");
  });

  it("should read one transcript for both facts, not one each", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [transcriptOf(SLUG, "a")]: `${JSON.stringify({ type: "user", cwd: "/work" })}\n` } });

    // Act
    await resolveName(seams, record({ sessionId: "a" }));

    // Assert
    expect(seams.fs.reads.filter((path) => path.endsWith(".jsonl"))).toEqual([transcriptOf(SLUG, "a")]);
  });

  it("should find a conversation filed nowhere near its cwd, with no slug recorded to point at it", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [transcriptOf(SLUG, "a")]: named("filed under the workspace root") } });

    // Act
    const resolved = await resolveName(seams, record({ sessionId: "a", cwd: "/a-worktree-it-cd-ed-into" }));

    // Assert
    expect(resolved.name).toBe("filed under the workspace root");
  });
});

describe("resolveNames", () => {
  const HOME = "/home/dev";
  const transcriptOf = (slug: string, sessionId: string) => transcriptPath(`${HOME}/.claude/projects/${slug}`, sessionId);
  const named = (name: string) => `${JSON.stringify({ type: "custom-title", customTitle: name })}\n`;
  const SLUG = "-filed-somewhere-else";

  it("should resolve each candidate against its own transcript, in the order it was given", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [transcriptOf(SLUG, "a")]: named("the work one"), [transcriptOf("-other", "b")]: named("the other one") }
    });

    // Act
    const resolved = await resolveNames(seams, [record({ sessionId: "a", cwd: "/work" }), record({ sessionId: "b", cwd: "/other" })]);

    // Assert
    expect(resolved.map((candidate) => candidate.name)).toEqual(["the work one", "the other one"]);
  });
});
