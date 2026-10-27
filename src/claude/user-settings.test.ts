import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { REGISTRATION_HOOK_OVERRIDE_WARNING, registrationHooks } from "./hooks.js";
import { API_KEY_HELPER_OVERRIDE_WARNING, extractUserSettings, mergeSettings, readUserSettings } from "./user-settings.js";

const HELPER = "/home/dev/.local/state/hai/gateway-token.sh";

describe("extractUserSettings", () => {
  it.each<[string, string[], string[], string | undefined]>([
    ["no --settings at all", ["-c"], ["-c"], undefined],
    ["nothing at all", [], [], undefined],
    ["inline json", ["--settings", '{"a":1}', "-c"], ["-c"], '{"a":1}'],
    ["a path", ["--settings", "mine.json"], [], "mine.json"],
    ["the --settings= form", ['--settings={"a":1}', "-c"], ["-c"], '{"a":1}'],
    ["the --settings= form with a path", ["--settings=mine.json"], [], "mine.json"],
    ["the last of two, as claude does", ["--settings", "a.json", "-c", "--settings", "b.json"], ["-c"], "b.json"],
    ["the last across both forms", ["--settings=a.json", "--settings", "b.json"], [], "b.json"],
    ["a value that looks like a flag", ["--settings", "--c"], [], "--c"],
    ["something that only looks like the flag", ["--settingsx", "-c"], ["--settingsx", "-c"], undefined],
    ["nothing after a bare --", ["--", "--settings", "x"], ["--", "--settings", "x"], undefined],
    ["only the one before a bare --", ["--settings", '{"a":1}', "--", "--settings", "y"], ["--", "--settings", "y"], '{"a":1}'],
    ["nothing from flags either side of a bare --", ["-c", "--", "-p", "hello"], ["-c", "--", "-p", "hello"], undefined],
    ["only the --settings= before a bare --", ["--settings=x", "--", "--settings=y"], ["--", "--settings=y"], "x"],
    ["the bare -- itself, which claude needs to find the end of its options", ["--settings=x", "--", "hello"], ["--", "hello"], "x"],
    ["a value that is itself --, since a value is never the terminator", ["--settings", "--", "-c"], ["-c"], "--"]
  ])("should take %s", (_name, argv, expectedArgv, expectedValue) => {
    // Act
    const result = extractUserSettings(argv);

    // Assert
    expect(result.argv).toEqual(expectedArgv);
    expect(result.value).toBe(expectedValue);
  });

  it("should reject a trailing --settings with no value", () => {
    // Act / Assert
    expect(() => extractUserSettings(["-c", "--settings"])).toThrow("--settings was given with no value");
  });

  it("should never leave a --settings behind for claude to see twice", () => {
    // Act
    const result = extractUserSettings(["--settings", "a.json", "--settings={}", "-c"]);

    // Assert
    expect(result.argv).not.toContain("--settings");
  });
});

describe("mergeSettings", () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, string[]]>([
    ["keep ours when there is nothing of theirs", { crossSessionInbound: "accept" }, {}, { crossSessionInbound: "accept" }, []],
    ["keep theirs when there is nothing of ours", {}, { cleanupPeriodDays: 42 }, { cleanupPeriodDays: 42 }, []],
    [
      "carry both when the keys do not collide",
      { crossSessionInbound: "accept" },
      { cleanupPeriodDays: 42 },
      { crossSessionInbound: "accept", cleanupPeriodDays: 42 },
      []
    ],
    ["let them override crossSessionInbound", { crossSessionInbound: "accept" }, { crossSessionInbound: "reject" }, { crossSessionInbound: "reject" }, []],
    [
      "let them override apiKeyHelper, but say so",
      { apiKeyHelper: HELPER },
      { apiKeyHelper: "/tmp/mine.sh" },
      { apiKeyHelper: "/tmp/mine.sh" },
      [API_KEY_HELPER_OVERRIDE_WARNING]
    ],
    ["say nothing when they set the same apiKeyHelper", { apiKeyHelper: HELPER }, { apiKeyHelper: HELPER }, { apiKeyHelper: HELPER }, []],
    ["say nothing when we had no apiKeyHelper to lose", {}, { apiKeyHelper: "/tmp/mine.sh" }, { apiKeyHelper: "/tmp/mine.sh" }, []]
  ])("should %s", (_name, ours, theirs, expectedSettings, expectedWarnings) => {
    // Act
    const result = mergeSettings(ours, theirs);

    // Assert
    expect(result.settings).toEqual(expectedSettings);
    expect(result.warnings).toEqual(expectedWarnings);
  });
});

describe("mergeSettings over hooks", () => {
  const OURS = { hooks: registrationHooks({ bin: ["hair"] }) };
  const THEIRS = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } };

  it("should keep both when the user registers a different event", () => {
    // Act
    const result = mergeSettings(OURS, THEIRS);

    // Assert
    expect(Object.keys(result.settings.hooks as object)).toEqual(["UserPromptSubmit", "SessionEnd", "PreToolUse"]);
    expect(result.warnings).toEqual([]);
  });

  it("should run ours first and then theirs when they register the same event", () => {
    // Act
    const result = mergeSettings(OURS, { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } });

    // Assert
    expect((result.settings.hooks as Record<string, unknown[]>).SessionEnd).toEqual([
      { hooks: [{ type: "command", command: "'hair' hook SessionEnd" }] },
      { hooks: [{ type: "command", command: "mine.sh" }] }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("should warn when the user's hooks are a shape that cannot be merged, theirs winning", () => {
    // Act
    const result = mergeSettings(OURS, { hooks: "nonsense" });

    // Assert
    expect(result.settings.hooks).toBe("nonsense");
    expect(result.warnings).toEqual([REGISTRATION_HOOK_OVERRIDE_WARNING]);
  });

  it("should warn when the user's hooks are a list, which claude's schema is not", () => {
    // Act / Assert
    expect(mergeSettings(OURS, { hooks: [] }).warnings).toEqual([REGISTRATION_HOOK_OVERRIDE_WARNING]);
  });

  it("should carry the user's hooks through untouched when hai registered none", () => {
    // Act
    const result = mergeSettings({}, THEIRS);

    // Assert
    expect(result.settings).toEqual(THEIRS);
    expect(result.warnings).toEqual([]);
  });

  it("should set no hooks key at all when neither side has any", () => {
    // Act / Assert
    expect(mergeSettings({ crossSessionInbound: "accept" }, {})).toEqual({ settings: { crossSessionInbound: "accept" }, warnings: [] });
  });

  it.each<[string, unknown]>([
    ["an event whose value is not a list of groups", { SessionEnd: "not a list" }],
    ["a group that is not an object", { SessionEnd: ["not a group"] }],
    ["a group whose hooks are not a list", { SessionEnd: [{ hooks: "not a list" }] }],
    ["an entry with no command", { SessionEnd: [{ hooks: [{ type: "command" }] }] }]
  ])("should find no command of ours to lose in %s", (_name, hooks) => {
    // Act / Assert
    expect(mergeSettings({ hooks }, {}).warnings).toEqual([]);
  });
});

describe("readUserSettings", () => {
  it.each<[string, string, Record<string, unknown>]>([
    ["inline json", '{"cleanupPeriodDays":42}', { cleanupPeriodDays: 42 }],
    ["inline json with leading whitespace", ' {"a":1}', { a: 1 }],
    ["an absolute path", "/work/mine.json", { a: 1 }],
    ["a path relative to the cwd", "mine.json", { a: 1 }],
    ["a dotted relative path", "./sub/../mine.json", { a: 1 }]
  ])("should read %s", async (_name, value, expected) => {
    // Arrange
    const seams = createFakeSeams({ cwd: "/work", files: { "/work/mine.json": '{"a":1}' } });

    // Act / Assert
    expect(await readUserSettings(seams, value)).toEqual(expected);
  });

  it.each<[string, string, string]>([
    ["a file that is not there", "missing.json", "--settings missing.json cannot be read (looked for /work/missing.json)"],
    ["a file that is not json", "broken.json", "--settings broken.json is not valid JSON"],
    ["inline json that does not parse", '{"a":', '--settings {"a": is not valid JSON'],
    ["an inline array", "[1,2]", "--settings [1,2] cannot be read (looked for /work/[1,2])"],
    ["a file holding an array", "array.json", "--settings array.json is not a JSON object"],
    ["a file holding a number", "number.json", "--settings number.json is not a JSON object"],
    ["a file holding null", "null.json", "--settings null.json is not a JSON object"]
  ])("should fail on %s", async (_name, value, expected) => {
    // Arrange
    const seams = createFakeSeams({
      cwd: "/work",
      files: { "/work/broken.json": "not json", "/work/array.json": "[1,2]", "/work/number.json": "42", "/work/null.json": "null" }
    });

    // Act / Assert
    await expect(readUserSettings(seams, value)).rejects.toThrow(expected);
  });
});
