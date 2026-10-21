import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { CLAUDE_JSON_MODE, mergeClaudeJson, SEEDED_KEYS, SEEDED_PROJECT_KEYS, seedClaudeJson } from "./claude-json.js";

const HOME = "/home/linus";
const PATH = `${HOME}/.claude.json`;
const WORKSPACE = "/home/linus/Work/solirius/hmcts";

const parse = (json: string) => JSON.parse(json) as Record<string, any>;

describe("mergeClaudeJson", () => {
  it("should set the onboarding and trust keys for the workspace", () => {
    // Act
    const merged = parse(mergeClaudeJson(null, WORKSPACE));

    // Assert
    for (const key of SEEDED_KEYS) {
      expect(merged[key]).toBe(true);
    }
    for (const key of SEEDED_PROJECT_KEYS) {
      expect(merged.projects[WORKSPACE][key]).toBe(true);
    }
  });

  it("should keep every other project and every other key", () => {
    // Arrange
    const existing = JSON.stringify({
      numStartups: 42,
      oauthAccount: { emailAddress: "dev@hmcts.net" },
      projects: { "/other/repo": { hasTrustDialogAccepted: true, lastCost: 1.5 } }
    });

    // Act
    const merged = parse(mergeClaudeJson(existing, WORKSPACE));

    // Assert
    expect(merged.numStartups).toBe(42);
    expect(merged.oauthAccount).toEqual({ emailAddress: "dev@hmcts.net" });
    expect(merged.projects["/other/repo"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 1.5 });
  });

  it("should keep what the workspace's own entry already holds", () => {
    // Arrange
    const existing = JSON.stringify({ projects: { [WORKSPACE]: { history: ["a prompt"], hasTrustDialogAccepted: false } } });

    // Act
    const merged = parse(mergeClaudeJson(existing, WORKSPACE));

    // Assert
    expect(merged.projects[WORKSPACE].history).toEqual(["a prompt"]);
    expect(merged.projects[WORKSPACE].hasTrustDialogAccepted).toBe(true);
  });

  it.each<[string, string]>([
    ["unparseable", "{ not json"],
    ["empty", "   "],
    ["an array", "[1,2]"],
    ["a scalar", "7"],
    ["projects that is not an object", '{"projects":[]}'],
    ["a project entry that is not an object", `{"projects":{"${WORKSPACE}":7}}`]
  ])("should start from nothing when the file is %s", (_name, existing) => {
    // Act
    const merged = parse(mergeClaudeJson(existing, WORKSPACE));

    // Assert
    expect(merged.hasCompletedOnboarding).toBe(true);
    expect(merged.projects[WORKSPACE].hasTrustDialogAccepted).toBe(true);
  });
});

describe("seedClaudeJson", () => {
  it("should write through a temp file and rename it into place", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [PATH]: "{}" } });

    // Act
    await seedClaudeJson(seams, { home: HOME, workspacePath: WORKSPACE, pid: 4242 });

    // Assert
    expect(parse(seams.fs.store.get(PATH)!).hasCompletedOnboarding).toBe(true);
    expect([...seams.fs.store.keys()]).toEqual([PATH]);
    expect(seams.fs.modes.get(PATH)).toBe(CLAUDE_JSON_MODE);
  });

  it("should leave an already-seeded file alone, rather than rewrite it on every launch", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [PATH]: mergeClaudeJson(null, WORKSPACE) } });
    const before = seams.fs.store.get(PATH);

    // Act
    await seedClaudeJson(seams, { home: HOME, workspacePath: WORKSPACE, pid: 4242 });

    // Assert
    expect(seams.fs.store.get(PATH)).toBe(before);
    expect(seams.fs.modes.has(PATH)).toBe(false);
  });

  it("should create the file when it is not there", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    await seedClaudeJson(seams, { home: HOME, workspacePath: WORKSPACE, pid: 4242 });

    // Assert
    expect(seams.fs.store.has(PATH)).toBe(true);
  });
});
