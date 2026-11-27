import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { attachedDir, leaveSession, markerPath, othersDecision, registerSession } from "./attached.js";

const HOME = "/home/linus";
const SESSION = "hai-hmcts-7293fcec";

describe("othersDecision", () => {
  it.each([
    { name: "nobody else", liveness: [], attached: false },
    { name: "only departed sessions", liveness: [false, false], attached: false },
    { name: "one live session", liveness: [false, true], attached: true },
    { name: "an unanswerable one and nothing live", liveness: [false, null], attached: true },
    { name: "a live one beside an unanswerable one", liveness: [null, true], attached: true }
  ])("should report $attached for $name", ({ liveness, attached }) => {
    // Act
    const decision = othersDecision(liveness);

    // Assert
    expect(decision.attached).toBe(attached);
  });
});

describe("registerSession and leaveSession", () => {
  it("should keep one marker per pid under the session's directory", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    await registerSession(seams, { sessionName: SESSION, pid: 100 });

    // Assert
    expect(markerPath(seams.env, SESSION, 100)).toBe(`${attachedDir(seams.env, SESSION)}/100`);
    expect(seams.fs.store.has(markerPath(seams.env, SESSION, 100))).toBe(true);
  });

  it("should ignore entries that are not pids, and never ask about its own", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [`${attachedDir({ HOME }, SESSION)}/notes`]: "" } });
    await registerSession(seams, { sessionName: SESSION, pid: 100 });

    // Act
    const attached = await leaveSession(seams, { sessionName: SESSION, pid: 100 });

    // Assert
    expect(attached).toBe(false);
    expect(seams.runner.calls).toEqual([]);
    expect(seams.fs.store.has(markerPath(seams.env, SESSION, 100))).toBe(false);
  });
});
