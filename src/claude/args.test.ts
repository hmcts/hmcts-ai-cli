import { describe, expect, it } from "vitest";
import { buildClaudeArgs, CLAUDE_BIN, forwardArgv } from "./args.js";

describe("forwardArgv", () => {
  it.each<[string, string[]]>([
    ["no arguments at all", []],
    ["what looks like a subcommand", ["mcp", "list"]],
    ["something that looks like one of ours", ["--settings", "{}", "--dangerously-skip-permissions"]]
  ])("should forward %s untouched", (_name, userArgs) => {
    // Arrange
    const processArgv = ["/usr/local/bin/node", "/usr/local/bin/hai", ...userArgs];

    // Act
    const result = forwardArgv(processArgv);

    // Assert
    expect(result).toEqual(userArgs);
  });

  it("should not share the caller's array", () => {
    // Arrange
    const processArgv = ["node", "hai", "-c"];

    // Act
    const result = forwardArgv(processArgv);
    result.push("--mutated");

    // Assert
    expect(processArgv).toEqual(["node", "hai", "-c"]);
  });
});

describe("buildClaudeArgs", () => {
  it("should build the argv a workspace session gets", () => {
    // Act
    const argv = buildClaudeArgs({
      settings: '{"crossSessionInbound":"accept"}',
      pluginDirs: ["/w/apps/pcs/.claude", "/w/apps/dtsse/.claude"],
      userArgs: ["-c"]
    });

    // Assert
    expect(argv).toEqual([
      CLAUDE_BIN,
      "--settings",
      '{"crossSessionInbound":"accept"}',
      "--plugin-dir",
      "/w/apps/pcs/.claude",
      "--plugin-dir",
      "/w/apps/dtsse/.claude",
      "-c"
    ]);
  });

  it("should add nothing of its own outside a workspace", () => {
    // Act
    const argv = buildClaudeArgs({ pluginDirs: [], userArgs: ["mcp", "list"] });

    // Assert
    expect(argv).toEqual([CLAUDE_BIN, "mcp", "list"]);
  });

  it("should never skip permissions by itself, and pass the flag on when the user types it", () => {
    // Act
    const ours = buildClaudeArgs({ settings: "{}", pluginDirs: [], userArgs: [] });
    const theirs = buildClaudeArgs({ settings: "{}", pluginDirs: [], userArgs: ["--dangerously-skip-permissions"] });

    // Assert
    expect(ours).not.toContain("--dangerously-skip-permissions");
    expect(theirs).toEqual([CLAUDE_BIN, "--settings", "{}", "--dangerously-skip-permissions"]);
  });

  it("should keep the user arguments last so they can override our flags", () => {
    // Act
    const argv = buildClaudeArgs({ settings: "{}", pluginDirs: [], userArgs: ["--model", "haiku"] });

    // Assert
    expect(argv.slice(-2)).toEqual(["--model", "haiku"]);
  });
});
