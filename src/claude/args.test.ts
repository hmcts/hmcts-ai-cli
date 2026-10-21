import { describe, expect, it } from "vitest";
import { buildClaudeArgs, CLAUDE_BIN, forwardArgv } from "./args.js";

describe("forwardArgv", () => {
  it.each<[string, string[]]>([
    ["no arguments at all", []],
    ["a short flag", ["-c"]],
    ["a flag with a value", ["-p", "x"]],
    ["what looks like a subcommand", ["doctor"]],
    ["a two-word subcommand", ["mcp", "list"]],
    ["help", ["--help"]],
    ["an argument hidden behind --", ["--", "-c"]],
    ["something that looks like one of ours", ["--settings", "{}", "--dangerously-skip-permissions"]],
    ["an empty string argument", [""]]
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
  it("should build the argv run.sh builds inside a workspace", () => {
    // Act
    const argv = buildClaudeArgs({
      settings: '{"crossSessionInbound":"accept"}',
      skipPermissions: true,
      pluginDirs: ["/w/apps/pcs/.claude", "/w/apps/dtsse/.claude"],
      userArgs: ["-c"]
    });

    // Assert
    expect(argv).toEqual([
      CLAUDE_BIN,
      "--settings",
      '{"crossSessionInbound":"accept"}',
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "/w/apps/pcs/.claude",
      "--plugin-dir",
      "/w/apps/dtsse/.claude",
      "-c"
    ]);
  });

  it("should add nothing of its own outside a workspace", () => {
    // Act
    const argv = buildClaudeArgs({ skipPermissions: false, pluginDirs: [], userArgs: ["mcp", "list"] });

    // Assert
    expect(argv).toEqual([CLAUDE_BIN, "mcp", "list"]);
  });

  it("should keep the user arguments last so they can override our flags", () => {
    // Act
    const argv = buildClaudeArgs({ settings: "{}", skipPermissions: true, pluginDirs: [], userArgs: ["--model", "haiku"] });

    // Assert
    expect(argv.slice(-2)).toEqual(["--model", "haiku"]);
  });
});
