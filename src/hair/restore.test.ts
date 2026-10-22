import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import type { SessionRecord } from "./registry.js";
import { describeCandidate, probeLiveness, restoreCandidates, restoreDecision } from "./restore.js";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({ sessionId: "a", cwd: "/work", state: "open", at: 10, pid: 100, ...over });

describe("restoreDecision", () => {
  it.each<[string, Partial<SessionRecord>, boolean | null, "restore" | "skip"]>([
    ["an open session whose process is gone", {}, false, "restore"],
    ["an open session whose process is still there", {}, true, "skip"],
    ["an open session whose process cannot be asked about", {}, null, "skip"],
    ["a session that was closed cleanly", { state: "closed" }, false, "skip"]
  ])("should %s", (_name, over, alive, action) => {
    // Act / Assert
    expect(restoreDecision({ record: record(over), alive }).action).toBe(action);
  });

  it("should say why a live session is left alone, because it would be forked rather than resumed", () => {
    // Act / Assert
    expect(restoreDecision({ record: record(), alive: true }).reason).toBe("pid 100 is still running, so the session is live");
  });

  it("should refuse to guess about a pid it could not ask about, as the transcript lock does", () => {
    // Act / Assert
    expect(restoreDecision({ record: record(), alive: null }).reason).toContain("cannot be told");
  });
});

describe("restoreCandidates", () => {
  it("should prefer this directory and then take the oldest, cwd being a preference and not a filter", () => {
    // Arrange
    const records = [
      record({ sessionId: "elsewhere-new", cwd: "/other", at: 40 }),
      record({ sessionId: "here-new", cwd: "/work", at: 30 }),
      record({ sessionId: "elsewhere-old", cwd: "/other", at: 10 }),
      record({ sessionId: "here-old", cwd: "/work", at: 20 })
    ];
    const liveness = new Map(records.map((r) => [r.sessionId, false as boolean | null]));

    // Act
    const { candidates } = restoreCandidates({ records, cwd: "/work", liveness });

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["here-old", "here-new", "elsewhere-old", "elsewhere-new"]);
  });

  it("should break a tie on the id, so two terminals walk the candidates in the same order", () => {
    // Arrange
    const records = [record({ sessionId: "b" }), record({ sessionId: "a" })];
    const liveness = new Map(records.map((r) => [r.sessionId, false as boolean | null]));

    // Act
    const { candidates } = restoreCandidates({ records, cwd: "/work", liveness });

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["a", "b"]);
  });

  it("should report what it skipped and why", () => {
    // Arrange
    const records = [record({ sessionId: "live" }), record({ sessionId: "dead" })];
    const liveness = new Map<string, boolean | null>([
      ["live", true],
      ["dead", false]
    ]);

    // Act
    const { candidates, skipped } = restoreCandidates({ records, cwd: "/work", liveness });

    // Assert
    expect(candidates.map((r) => r.sessionId)).toEqual(["dead"]);
    expect(skipped).toEqual([{ record: record({ sessionId: "live" }), reason: "pid 100 is still running, so the session is live" }]);
  });

  it("should treat a session it has no liveness answer for as unanswerable", () => {
    // Act
    const { candidates } = restoreCandidates({ records: [record()], cwd: "/work", liveness: new Map() });

    // Assert
    expect(candidates).toEqual([]);
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

describe("probeLiveness", () => {
  it.each<[string, number, string, boolean | null]>([
    ["a pid that is still there", 0, "42\n", true],
    ["a pid that is gone", 1, "", false],
    ["a machine with no ps on it, which is not grounds to resume anything", 127, "", null]
  ])("should read %s", async (_name, code, stdout, expected) => {
    // Arrange
    const seams = createFakeSeams({ respond: (argv) => (argv[0] === "ps" ? { code, stdout } : undefined) });

    // Act
    const liveness = await probeLiveness(seams, [record({ pid: 42 })]);

    // Assert
    expect(seams.runner.calls[0]?.argv).toEqual(["ps", "-p", "42", "-o", "pid="]);
    expect(liveness.get("a")).toBe(expected);
  });

  it("should treat a record with no pid as owned by nobody rather than ask about pid 0", async () => {
    // Arrange
    const seams = createFakeSeams();

    // Act
    const liveness = await probeLiveness(seams, [record({ pid: 0 })]);

    // Assert
    expect(seams.runner.calls).toEqual([]);
    expect(liveness.get("a")).toBe(false);
  });
});
