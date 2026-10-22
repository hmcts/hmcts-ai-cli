import { describe, expect, it } from "vitest";
import { createFakeSeams, type FakeSeams } from "./__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "./az/group-membership.js";
import { haiScriptPath } from "./claude/hooks.js";
import { claimPath, recordLine, registryPath, type SessionRecord } from "./hair/registry.js";
import { launchHair, NOTHING_TO_RESTORE } from "./hair-launch.js";
import { packageRoot } from "./update/self-update.js";

const HOME = "/home/dev";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const REGISTRY = registryPath({ HOME })!;
/** In a container, so `launch` hands over in place rather than starting one. */
const IN_CONTAINER = { "/.dockerenv": "" };

/** The fake seams' own hostname, so a recorded pid is one `hair` may ask `ps` about. */
const HOST = "workstation";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s1",
  cwd: "/work",
  state: "open",
  at: 10,
  pid: 100,
  host: HOST,
  ...over
});

/** Everything launch asks a host about, plus a `ps` that says every recorded pid is gone. */
function respond(argv: string[]) {
  if (argv[0] === "ps") {
    return { code: 1, stdout: "" };
  }
  if (argv[1] === "account") {
    return { stdout: JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } }) };
  }
  if (argv[1] === "rest") {
    return { stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) };
  }
  return { code: 0 };
}

function seamsIn(files: Record<string, string> = {}, over: Parameters<typeof createFakeSeams>[0] = {}) {
  const seams = createFakeSeams({
    env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY },
    cwd: "/work",
    files: { ...IN_CONTAINER, ...files },
    respond,
    ...over
  });
  // The directories the records point at. A registered conversation whose directory has
  // been deleted is a skip, not a chdir that throws.
  for (const dir of ["/work", "/other", "/elsewhere"]) {
    seams.fs.dirs.add(dir);
  }
  return seams;
}

const execArgv = (seams: FakeSeams) => seams.runner.execCalls[0]?.argv ?? [];

describe("launchHair", () => {
  describe("resuming", () => {
    it("should claim a conversation and hand -r to hai's own launch, never spawning claude itself", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record()) });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(execArgv(seams)[0]).toBe("claude");
      expect(execArgv(seams).slice(-2)).toEqual(["-r", "s1"]);
      expect(seams.fs.store.has(claimPath({ HOME }, "s1")!)).toBe(true);
    });

    /**
     * The one field that makes `hair --list` usable. The resumed session's own hook reads
     * the name off the argv, so without this a session started as `hai -n pcs` comes back
     * nameless and shows as "(unnamed)" for ever after.
     */
    it("should put the record's name back on the argv, so the re-registration keeps it", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record({ name: "the pcs one" })) });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(execArgv(seams).slice(-4)).toEqual(["-r", "s1", "--name", "the pcs one"]);
    });

    /**
     * `process.chdir` throws, and the claim is taken before the handover: a claim taken
     * and then a throw would end `hair` with the claim held, and the next run would
     * reclaim the same record and fail again until the registry was hand-edited.
     */
    it("should skip a conversation whose directory has been deleted, without claiming it", async () => {
      // Arrange
      const seams = seamsIn(
        { [REGISTRY]: recordLine(record({ cwd: "/deleted-worktree" })) },
        { env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY, HAI_VERBOSE: "1" } }
      );

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(seams.chdirs).toEqual([]);
      expect(seams.fs.store.has(claimPath({ HOME }, "s1")!)).toBe(false);
      expect(seams.lines.join("")).toContain("its directory /deleted-worktree is gone");
    });

    it.each<[string, string[]]>([
      ["-r, a natural typo of hai -r", ["-r", "abc"]],
      ["--resume=", ["--resume=abc"]],
      ["-c", ["-c"]],
      ["--continue", ["--continue"]]
    ])("should claim nothing when the arguments already say which conversation to open, given %s", async (_name, args) => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record()) });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair", ...args] });

      // Assert
      expect(execArgv(seams).slice(-args.length)).toEqual(args);
      expect(execArgv(seams)).not.toContain("s1");
      expect(seams.fs.store.has(claimPath({ HOME }, "s1")!)).toBe(false);
    });

    it("should forward the extra arguments it was given after the resume", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record()) });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair", "--model", "opus"] });

      // Assert
      expect(execArgv(seams).slice(-4)).toEqual(["-r", "s1", "--model", "opus"]);
    });

    it("should move to the record's directory, resume-by-id not being cwd-scoped", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record({ cwd: "/elsewhere" })) });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(seams.chdirs).toEqual(["/elsewhere"]);
    });

    it("should claim before handing over, so the resumed session's own hook cannot be read as free", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record()) });
      const claimedAtHandover: boolean[] = [];
      seams.runner.exec = async () => {
        claimedAtHandover.push(seams.fs.store.has(claimPath({ HOME }, "s1")!));
        return undefined as never;
      };

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(claimedAtHandover).toEqual([true]);
    });

    it("should give two terminals two different conversations", async () => {
      // Arrange
      const files = { [REGISTRY]: `${recordLine(record({ sessionId: "s1", at: 10 }))}${recordLine(record({ sessionId: "s2", at: 20 }))}` };
      const first = seamsIn(files, { pid: 1 });
      // The second terminal reads the registry and the claims the first one left behind.
      const second = seamsIn({ ...files }, { pid: 2 });

      // Act
      await launchHair({ seams: first, processArgv: ["node", "/bin/hair"] });
      for (const [path, contents] of first.fs.store) {
        if (path.includes("hair-claims")) {
          second.fs.store.set(path, contents);
        }
      }
      // The pid that took the first claim is still running, as a handed-over session is,
      // while the pids the crashed sessions were recorded under are still gone.
      second.runner.run = async (argv) => (argv[0] === "ps" && argv[2] === "1" ? { code: 0, stdout: "1\n", stderr: "" } : { code: 1, stdout: "", stderr: "" });
      await launchHair({ seams: second, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(execArgv(first).slice(-2)).toEqual(["-r", "s1"]);
      expect(execArgv(second).slice(-2)).toEqual(["-r", "s2"]);
    });

    it("should start a fresh session when there is nothing waiting, rather than refuse to run", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(execArgv(seams)).not.toContain("-r");
      expect(seams.lines.join("")).toContain(NOTHING_TO_RESTORE);
      expect(seams.chdirs).toEqual([]);
    });

    it("should leave a live session alone, -r on one forking a copy rather than attaching", async () => {
      // Arrange
      const seams = seamsIn(
        { [REGISTRY]: recordLine(record()) },
        {
          respond: (argv) => (argv[0] === "ps" ? { code: 0, stdout: "100\n" } : respond(argv))
        }
      );

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair"] });

      // Assert
      expect(execArgv(seams)).not.toContain("-r");
    });

    /**
     * `process.argv[1]` for a global install is the bin **symlink** — `<prefix>/bin/hair`,
     * no `.js` — so the script a self-update re-execs cannot be derived from it. Re-entering
     * `hair` there would claim a second conversation and emit `-r <new> -r <old>`.
     */
    it("should hand hai's own entrypoint over, so a self-update does not re-enter hair", async () => {
      // Arrange
      const seams = seamsIn(
        {
          [REGISTRY]: recordLine(record()),
          // A published version, with a newer one on the feed: that is what re-execs.
          [`${packageRoot()}package.json`]: JSON.stringify({ version: "0.1.0" })
        },
        {
          env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY },
          // The bin symlink, as node reports it.
          scriptPath: "/usr/local/bin/hair",
          fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }))
        }
      );

      // Act
      await launchHair({ seams, processArgv: ["node", "/usr/local/bin/hair"] });

      // Assert
      expect(execArgv(seams)).toEqual([seams.execPath, haiScriptPath(), "-r", "s1"]);
      expect(haiScriptPath()).toMatch(/\/bin\/hai\.js$/);
    });
  });

  describe("--list", () => {
    it("should print the candidates without claiming any of them", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: `${recordLine(record({ name: "pcs" }))}${recordLine(record({ sessionId: "s2", cwd: "/other", at: 20 }))}` });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair", "--list"] });

      // Assert
      expect(seams.out.join("")).toBe("s1  pcs  this directory\ns2  (unnamed)  /other\n");
      expect(seams.fs.store.has(claimPath({ HOME }, "s1")!)).toBe(false);
      expect(seams.runner.execCalls).toEqual([]);
    });

    it("should say so when nothing is waiting", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair", "--list"] });

      // Assert
      expect(seams.out.join("")).toBe(`${NOTHING_TO_RESTORE}\n`);
    });

    it("should explain what it passed over when asked to", async () => {
      // Arrange
      const seams = seamsIn({ [REGISTRY]: recordLine(record({ state: "closed" })) }, { env: { HOME, HAI_VERBOSE: "1" } });

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair", "--list"] });

      // Assert
      expect(seams.lines.join("")).toContain("s1: the session was closed cleanly");
    });
  });

  describe("hook", () => {
    it("should maintain the registry and run no claude at all", async () => {
      // Arrange
      const seams = seamsIn(
        {},
        {
          env: { HOME, CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: "900" },
          stdinText: JSON.stringify({ session_id: "s1", cwd: "/work" })
        }
      );

      // Act
      await launchHair({ seams, processArgv: ["node", "/bin/hair", "hook", "UserPromptSubmit"] });

      // Assert
      expect(seams.fs.store.get(REGISTRY)).toContain('"sessionId":"s1"');
      expect(seams.runner.execCalls).toEqual([]);
      expect(seams.runner.interactiveCalls).toEqual([]);
    });
  });
});
