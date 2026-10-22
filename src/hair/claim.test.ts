import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { type ClaimFile, claimContents, claimDecision, claimFirst, parseClaim, releaseClaim } from "./claim.js";
import { claimPath, type SessionRecord } from "./registry.js";

const HOME = "/home/dev";
/** The fake seams' own hostname, so a claim is one this terminal could have written. */
const HOST = "workstation";
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({ sessionId: "a", cwd: "/work", state: "open", at: 10, pid: 100, ...over });
const held = (over: Partial<ClaimFile> = {}) => JSON.stringify({ pid: 77, at: 1, host: HOST, ...over });
const alive = (argv: string[]) => (argv[0] === "ps" ? { code: 0, stdout: "77\n" } : undefined);
const dead = (argv: string[]) => (argv[0] === "ps" ? { code: 1, stdout: "" } : undefined);

describe("claimDecision", () => {
  it.each<[string, ClaimFile | null, boolean | null, "take" | "reclaim" | "taken"]>([
    ["nothing holds it", null, null, "take"],
    ["the terminal that held it is gone", { pid: 7, at: 1, host: HOST }, false, "reclaim"],
    ["another terminal holds it", { pid: 7, at: 1, host: HOST }, true, "taken"],
    ["the holder cannot be asked about", { pid: 7, at: 1, host: HOST }, null, "taken"]
  ])("should decide when %s", (_name, existing, pidAlive, action) => {
    // Act / Assert
    expect(claimDecision({ existing, host: HOST, alive: pidAlive }).action).toBe(action);
  });

  /**
   * A claimer's pid is in the claimer's own PID namespace. Reclaiming on a liveness
   * answer from the wrong one is how two terminals both decide a conversation is theirs.
   */
  it.each<[string, ClaimFile]>([
    ["another host", { pid: 7, at: 1, host: "a1b2c3" }],
    ["a claim that names no host, as an older release's would", { pid: 7, at: 1 }]
  ])("should never reclaim a claim written on %s, however dead its pid looks", (_name, existing) => {
    // Act
    const outcome = claimDecision({ existing, host: HOST, alive: false });

    // Assert
    expect(outcome.action).toBe("taken");
    expect(outcome.reason).toContain(existing.host ?? "an unnamed host");
  });
});

describe("parseClaim", () => {
  it.each<[string, string | null]>([
    ["nothing there", null],
    ["half a write", '{"pid"'],
    ["a claim with no pid at all", "{}"]
  ])("should read %s as unheld", (_name, contents) => {
    // Act / Assert
    expect(parseClaim(contents)).toBeNull();
  });

  it("should round-trip what it writes", () => {
    // Act / Assert
    expect(parseClaim(claimContents({ pid: 9, at: 5, host: HOST }))).toEqual({ pid: 9, at: 5, host: HOST });
  });

  it.each<[string, string, ClaimFile]>([
    ["no timestamp", '{"pid":9}', { pid: 9, at: 0 }],
    ["an empty host", '{"pid":9,"at":5,"host":""}', { pid: 9, at: 5 }]
  ])("should still read a claim written with %s", (_name, contents, expected) => {
    // Act / Assert
    expect(parseClaim(contents)).toEqual(expected);
  });
});

describe("claimFirst", () => {
  const seamsIn = (files: Record<string, string> = {}, respond = dead) => createFakeSeams({ env: { HOME }, files, respond, pid: 4242, cwd: "/work" });

  it("should claim the first candidate and record this terminal's pid", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    const claimed = await claimFirst(seams, [record({ sessionId: "a" }), record({ sessionId: "b" })]);

    // Assert
    expect(claimed?.sessionId).toBe("a");
    expect(seams.fs.store.get(claimPath({ HOME }, "a")!)).toBe(`${JSON.stringify({ pid: 4242, at: FIXED_NOW, host: HOST })}\n`);
    expect(seams.fs.modes.get(claimPath({ HOME }, "a")!)).toBe(0o600);
  });

  it("should move to the next candidate when another live terminal already claimed one", async () => {
    // Arrange
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: held() }, alive);

    // Act
    const claimed = await claimFirst(seams, [record({ sessionId: "a" }), record({ sessionId: "b" })]);

    // Assert
    expect(claimed?.sessionId).toBe("b");
  });

  it("should reclaim a claim whose terminal a reboot took, or the registry would work exactly once", async () => {
    // Arrange
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: held() }, dead);

    // Act
    const claimed = await claimFirst(seams, [record({ sessionId: "a" })]);

    // Assert
    expect(claimed?.sessionId).toBe("a");
    expect(seams.fs.store.get(claimPath({ HOME }, "a")!)).toContain('"pid":4242');
    expect([...seams.fs.store.keys()].filter((key) => key.endsWith(".stale"))).toEqual([]);
  });

  it("should lose the reclaim gracefully when another terminal renamed the stale claim first", async () => {
    // Arrange
    const path = claimPath({ HOME }, "a")!;
    const seams = seamsIn({ [path]: held() }, dead);
    // The rename is the race: the loser finds the file already moved out of the way.
    seams.fs.rename = async () => {
      throw new Error("no such file");
    };

    // Act
    const claimed = await claimFirst(seams, [record({ sessionId: "a" })]);

    // Assert
    expect(claimed).toBeNull();
  });

  it("should reclaim a claim nothing can be read out of, rather than leave it unclaimable", async () => {
    // Arrange
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: "half a wri" });

    // Act
    const claimed = await claimFirst(seams, [record({ sessionId: "a" })]);

    // Assert
    expect(claimed?.sessionId).toBe("a");
    expect(seams.runner.calls).toEqual([]);
  });

  it("should return nothing when every candidate is taken", async () => {
    // Arrange
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: held() }, alive);

    // Act / Assert
    expect(await claimFirst(seams, [record({ sessionId: "a" })])).toBeNull();
  });

  it("should claim nothing when there is no HOME to keep the claims under", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {}, respond: dead });

    // Act / Assert
    expect(await claimFirst(seams, [record()])).toBeNull();
  });
});

describe("releaseClaim", () => {
  it("should remove the claim the ending session held", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [claimPath({ HOME }, "a")!]: "{}" } });

    // Act
    await releaseClaim(seams, "a");

    // Assert
    expect(seams.fs.store.has(claimPath({ HOME }, "a")!)).toBe(false);
  });

  it("should do nothing when there is no HOME", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {} });

    // Act / Assert
    await expect(releaseClaim(seams, "a")).resolves.toBeUndefined();
  });
});
