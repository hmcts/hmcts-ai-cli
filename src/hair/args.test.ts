import { describe, expect, it } from "vitest";
import { forwardsItsOwnSession, type HairMode, parseHairArgs } from "./args.js";

const argv = (...args: string[]) => ["node", "/usr/bin/hair", ...args];

describe("parseHairArgs", () => {
  it.each<[string, string[], HairMode]>([
    ["bare", [], { kind: "resume", forward: [] }],
    ["--list", ["--list"], { kind: "list" }],
    ["a hook event", ["hook", "SessionEnd"], { kind: "hook", event: "SessionEnd", name: undefined }],
    ["a hook event with a name", ["hook", "UserPromptSubmit", "--name", "pcs"], { kind: "hook", event: "UserPromptSubmit", name: "pcs" }],
    ["a hook with no event at all", ["hook"], { kind: "hook", event: "", name: undefined }],
    ["a hook whose --name has no value", ["hook", "SessionEnd", "--name"], { kind: "hook", event: "SessionEnd", name: undefined }]
  ])("should read %s", (_name, args, expected) => {
    // Act / Assert
    expect(parseHairArgs(argv(...args))).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["a model flag", ["--model", "opus"]],
    ["a resume of a named id", ["-r", "abc"]],
    ["--list anywhere but first, because claude owns everything after the first word", ["--model", "opus", "--list"]],
    ["hook anywhere but first", ["--model", "hook"]],
    ["a prompt that happens to read like a flag", ["--", "--list"]]
  ])("should forward %s verbatim", (_name, args) => {
    // Act / Assert
    expect(parseHairArgs(argv(...args))).toEqual({ kind: "resume", forward: args });
  });
});

describe("forwardsItsOwnSession", () => {
  it.each<[string, string[]]>([
    ["-r with an id", ["-r", "abc"]],
    ["--resume", ["--resume", "abc"]],
    ["--resume=", ["--resume=abc"]],
    ["-c", ["-c"]],
    ["--continue", ["--continue"]],
    ["--continue=", ["--continue=3"]],
    ["one of them after other flags", ["--model", "opus", "-c"]]
  ])("should see %s", (_name, args) => {
    // Act / Assert
    expect(forwardsItsOwnSession(args)).toBe(true);
  });

  it.each<[string, string[]]>([
    ["nothing at all", []],
    ["flags that start no particular conversation", ["--model", "opus"]],
    ["a prompt that only looks like one, after a bare --", ["--", "-c"]],
    ["a flag that merely starts the same way", ["--resumes-nothing"]]
  ])("should see no session named in %s", (_name, args) => {
    // Act / Assert
    expect(forwardsItsOwnSession(args)).toBe(false);
  });
});
