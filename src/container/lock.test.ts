import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW, type RunResponder } from "../__fixtures__/fake-seams.js";
import { CONCURRENT_REFUSAL, type LockFile, lockDecision, lockPath, parseLock, releaseLock, takeLock } from "./lock.js";

const SESSION = "hai-hmcts-abcd1234";
const HOME = "/home/linus";
const REPO = "/home/linus/Work/solirius/hmcts";
const PATH = `${HOME}/.claude/projects/-home-linus-Work-solirius-hmcts/.hai.lock`;

const HELD: LockFile = { pid: 999, container: "hai-hmcts-other111", at: FIXED_NOW - 1000 };

const base = {
  existing: null as LockFile | null,
  sessionName: SESSION,
  allowConcurrent: false,
  containerRunning: null as boolean | null,
  pidAlive: null as boolean | null
};

describe("lockPath", () => {
  it("should sit under the project directory Claude Code keys the transcripts on", () => {
    // Act / Assert
    expect(lockPath({ home: HOME, workdir: REPO })).toBe(PATH);
  });
});

describe("lockDecision", () => {
  it.each<[string, Partial<typeof base>, string]>([
    ["no lock is there", {}, "take"],
    ["the lock is this session's own", { existing: { ...HELD, container: SESSION } }, "reclaim"],
    ["the container that held it is gone", { existing: HELD, containerRunning: false, pidAlive: true }, "reclaim"],
    ["the process that held it is gone", { existing: HELD, containerRunning: null, pidAlive: false }, "reclaim"],
    ["both are gone", { existing: HELD, containerRunning: false, pidAlive: false }, "reclaim"],
    ["the holder is alive", { existing: HELD, containerRunning: true, pidAlive: true }, "refuse"],
    ["neither question could be answered", { existing: HELD, containerRunning: null, pidAlive: null }, "refuse"],
    ["HAI_ALLOW_CONCURRENT is set", { existing: HELD, containerRunning: true, pidAlive: true, allowConcurrent: true }, "skip"]
  ])("should decide when %s", (_name, overrides, action) => {
    // Act / Assert
    expect(lockDecision({ ...base, ...overrides }).action).toBe(action);
  });

  it("should name the one way out when it refuses", () => {
    // Act
    const outcome = lockDecision({ ...base, existing: HELD, containerRunning: true, pidAlive: true });

    // Assert
    expect(outcome.reason).toBe(CONCURRENT_REFUSAL);
    expect(outcome.reason).toContain("HAI_ALLOW_CONCURRENT=1");
  });

  it("should say which container or process it reclaimed from", () => {
    // Act / Assert
    expect(lockDecision({ ...base, existing: HELD, containerRunning: false }).reason).toContain("hai-hmcts-other111");
    expect(lockDecision({ ...base, existing: HELD, pidAlive: false }).reason).toContain("pid 999");
  });
});

describe("parseLock", () => {
  it.each<[string, string | null]>([
    ["nothing there", null],
    ["unparseable JSON", "{"],
    ["no pid", '{"container":"x"}'],
    ["a pid that is not a number", '{"pid":"nope","container":"x"}'],
    ["no container", '{"pid":1}']
  ])("should read %s as no lock", (_name, contents) => {
    // Act / Assert
    expect(parseLock(contents)).toBeNull();
  });

  it("should read a lock that is there", () => {
    // Act / Assert
    expect(parseLock('{"pid":7,"container":"c","at":5}')).toEqual({ pid: 7, container: "c", at: 5 });
    expect(parseLock('{"pid":7,"container":"c"}')).toEqual({ pid: 7, container: "c", at: 0 });
  });
});

describe("takeLock", () => {
  const seamsWith = (files: Record<string, string> = {}, respond?: RunResponder) => createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, files, respond });

  const input = { path: PATH, sessionName: SESSION, pid: 4242, allowConcurrent: false };

  it("should write the lock when nothing holds it", async () => {
    // Arrange
    const seams = seamsWith();

    // Act
    const lock = await takeLock(seams, input);

    // Assert
    expect(lock.path).toBe(PATH);
    expect(JSON.parse(seams.fs.store.get(PATH)!)).toEqual({ pid: 4242, container: SESSION, at: FIXED_NOW });
  });

  it("should reclaim silently when docker says the holder's container is gone", async () => {
    // Arrange
    const seams = seamsWith({ [PATH]: JSON.stringify(HELD) }, (argv) =>
      argv[0] === "docker" ? { code: 1, stderr: "Error: No such object: hai-hmcts-other111" } : { code: 0, stdout: "999\n" }
    );

    // Act
    const lock = await takeLock(seams, input);

    // Assert
    expect(lock.path).toBe(PATH);
    expect(seams.lines.join("")).toContain("is gone");
  });

  it("should reclaim when the holder's process is gone", async () => {
    // Arrange
    const seams = seamsWith({ [PATH]: JSON.stringify(HELD) }, (argv) =>
      argv[0] === "docker" ? { code: 125, stderr: "Cannot connect to the Docker daemon" } : { code: 1 }
    );

    // Act / Assert
    expect((await takeLock(seams, input)).path).toBe(PATH);
  });

  it("should refuse while the holder is still running", async () => {
    // Arrange
    const seams = seamsWith({ [PATH]: JSON.stringify(HELD) }, (argv) => (argv[0] === "docker" ? { code: 0, stdout: "true\n" } : { code: 0, stdout: "999\n" }));

    // Act / Assert
    await expect(takeLock(seams, input)).rejects.toThrow(CONCURRENT_REFUSAL);
    expect(seams.fs.store.get(PATH)).toBe(JSON.stringify(HELD));
  });

  it("should take no lock at all under HAI_ALLOW_CONCURRENT", async () => {
    // Arrange
    const seams = seamsWith();

    // Act
    const lock = await takeLock(seams, { ...input, allowConcurrent: true });

    // Assert
    expect(lock.path).toBeNull();
    expect(seams.fs.store.has(PATH)).toBe(false);
  });

  it("should treat a stopped container as gone", async () => {
    // Arrange
    const seams = seamsWith({ [PATH]: JSON.stringify(HELD) }, (argv) => (argv[0] === "docker" ? { code: 0, stdout: "false\n" } : { code: 0, stdout: "999\n" }));

    // Act / Assert
    expect((await takeLock(seams, input)).path).toBe(PATH);
  });

  it("should refuse rather than guess when ps itself could not run", async () => {
    // Arrange — an unanswerable question is not grounds to take someone else's lock.
    const seams = seamsWith({ [PATH]: JSON.stringify(HELD) }, (argv) =>
      argv[0] === "docker" ? { code: 125, stderr: "daemon unreachable" } : { code: 127, stderr: "ps: not found" }
    );

    // Act / Assert
    await expect(takeLock(seams, input)).rejects.toThrow(CONCURRENT_REFUSAL);
  });

  it("should treat an empty ps answer as no such process", async () => {
    // Arrange
    const seams = seamsWith({ [PATH]: JSON.stringify(HELD) }, (argv) =>
      argv[0] === "docker" ? { code: 125, stderr: "daemon unreachable" } : { code: 0, stdout: "\n" }
    );

    // Act / Assert
    expect((await takeLock(seams, input)).path).toBe(PATH);
  });
});

describe("releaseLock", () => {
  it("should remove the lock it took", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [PATH]: "{}" } });

    // Act
    await releaseLock(seams, { path: PATH });

    // Assert
    expect(seams.fs.store.has(PATH)).toBe(false);
  });

  it("should do nothing when no lock was taken", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [PATH]: "{}" } });

    // Act
    await releaseLock(seams, { path: null });

    // Assert
    expect(seams.fs.store.has(PATH)).toBe(true);
  });
});
