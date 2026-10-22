import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { type ClaimFile, claimContents, claimDecision, claimFirst, parseClaim, releaseClaim } from "./claim.js";
import { claimPath, type SessionRecord } from "./registry.js";

const HOME = "/home/dev";
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({ sessionId: "a", cwd: "/work", state: "open", at: 10, pid: 100, ...over });
const alive = (argv: string[]) => (argv[0] === "ps" ? { code: 0, stdout: "77\n" } : undefined);
const dead = (argv: string[]) => (argv[0] === "ps" ? { code: 1, stdout: "" } : undefined);

describe("claimDecision", () => {
  it.each<[string, ClaimFile | null, boolean | null, "take" | "reclaim" | "taken"]>([
    ["nothing holds it", null, null, "take"],
    ["the terminal that held it is gone", { pid: 7, at: 1 }, false, "reclaim"],
    ["another terminal holds it", { pid: 7, at: 1 }, true, "taken"],
    ["the holder cannot be asked about", { pid: 7, at: 1 }, null, "taken"]
  ])("should decide when %s", (_name, existing, pidAlive, action) => {
    // Act / Assert
    expect(claimDecision({ existing, alive: pidAlive }).action).toBe(action);
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
    expect(parseClaim(claimContents({ pid: 9, at: 5 }))).toEqual({ pid: 9, at: 5 });
  });

  it("should still read a claim an older release wrote without a timestamp", () => {
    // Act / Assert
    expect(parseClaim('{"pid":9}')).toEqual({ pid: 9, at: 0 });
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
    expect(seams.fs.store.get(claimPath({ HOME }, "a")!)).toBe(`${JSON.stringify({ pid: 4242, at: FIXED_NOW })}\n`);
    expect(seams.fs.modes.get(claimPath({ HOME }, "a")!)).toBe(0o600);
  });

  it("should move to the next candidate when another live terminal already claimed one", async () => {
    // Arrange
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: JSON.stringify({ pid: 77, at: 1 }) }, alive);

    // Act
    const claimed = await claimFirst(seams, [record({ sessionId: "a" }), record({ sessionId: "b" })]);

    // Assert
    expect(claimed?.sessionId).toBe("b");
  });

  it("should reclaim a claim whose terminal a reboot took, or the registry would work exactly once", async () => {
    // Arrange
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: JSON.stringify({ pid: 77, at: 1 }) }, dead);

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
    const seams = seamsIn({ [path]: JSON.stringify({ pid: 77, at: 1 }) }, dead);
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
    const seams = seamsIn({ [claimPath({ HOME }, "a")!]: JSON.stringify({ pid: 77, at: 1 }) }, alive);

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
