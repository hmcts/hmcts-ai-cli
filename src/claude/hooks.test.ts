import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { SESSION_END, USER_PROMPT_SUBMIT } from "../hair/hook.js";
import {
  hairCommand,
  haiScriptPath,
  hookCommand,
  registrationHooks,
  sessionDisplayName,
  sessionRegistryHooks,
  shellQuote,
  shouldRegisterSession
} from "./hooks.js";

const DIST = "/usr/local/lib/node_modules/@hmcts-cft/hai-cli/dist/bin";

describe("shouldRegisterSession", () => {
  it.each<[string, string[]]>([
    ["an interactive session", []],
    ["a continued conversation", ["-c"]],
    ["a resume, which is how a restored session re-registers itself", ["-r", "abc"]],
    ["a session with a name", ["-n", "pcs"]],
    ["a prompt that only looks like --print", ["--", "--print"]],
    ["a subcommand, which starts no session but costs nothing", ["mcp", "list"]]
  ])("should register %s", (_name, argv) => {
    // Act / Assert
    expect(shouldRegisterSession(argv)).toBe(true);
  });

  it.each<[string, string[]]>([
    ["-p, which is a script", ["-p", "summarise"]],
    ["--print", ["--print"]],
    ["--bg, which is a job nobody resumes", ["--bg", "do the thing"]],
    ["--background", ["--background"]],
    ["-p after other flags", ["--model", "opus", "-p", "x"]]
  ])("should register nothing for %s", (_name, argv) => {
    // Act / Assert
    expect(shouldRegisterSession(argv)).toBe(false);
  });
});

describe("sessionDisplayName", () => {
  it.each<[string, string[], string | undefined]>([
    ["-n", ["-n", "pcs"], "pcs"],
    ["--name", ["--name", "pcs"], "pcs"],
    ["--name=", ["--name=pcs"], "pcs"],
    ["no name at all", ["-c"], undefined],
    ["-n with no value", ["-n"], undefined],
    ["a name in the prompt text after --", ["--", "--name", "pcs"], undefined]
  ])("should read %s", (_name, argv, expected) => {
    // Act / Assert
    expect(sessionDisplayName(argv)).toBe(expected);
  });
});

describe("shellQuote", () => {
  it.each<[string, string, string]>([
    ["an ordinary word", "pcs", "'pcs'"],
    ["a name with a space", "the pcs one", "'the pcs one'"],
    ["a name with a quote in it", "linus's", `'linus'\\''s'`],
    ["a name that tries to be more argv", "x'; rm -rf /; echo '", `'x'\\''; rm -rf /; echo '\\'''`]
  ])("should quote %s", (_name, value, expected) => {
    // Act / Assert
    expect(shellQuote(value)).toBe(expected);
  });
});

describe("hookCommand", () => {
  it("should quote the command and pass the event, claude running a hook through sh -c", () => {
    // Act / Assert
    expect(hookCommand({ bin: ["/bin/node", `${DIST}/hair.js`], event: SESSION_END })).toBe(`'/bin/node' '${DIST}/hair.js' hook SessionEnd`);
  });

  it.each<[string, string | undefined, string]>([
    ["a name", "the pcs one", "'hair' hook SessionEnd --name 'the pcs one'"],
    ["no name", undefined, "'hair' hook SessionEnd"],
    ["an empty name", "", "'hair' hook SessionEnd"]
  ])("should add %s", (_name, name, expected) => {
    // Act / Assert
    expect(hookCommand({ bin: ["hair"], event: SESSION_END, name })).toBe(expected);
  });
});

describe("registrationHooks", () => {
  it("should register the two events the registry is maintained from", () => {
    // Act
    const hooks = registrationHooks({ bin: ["hair"] });

    // Assert
    expect(Object.keys(hooks)).toEqual([USER_PROMPT_SUBMIT, SESSION_END]);
    expect(hooks[USER_PROMPT_SUBMIT]).toEqual([{ hooks: [{ type: "command", command: "'hair' hook UserPromptSubmit" }] }]);
  });
});

describe("hairCommand", () => {
  it("should pin the in-place hook at this interpreter and this release's own hair.js", () => {
    // Act / Assert
    expect(hairCommand({ execPath: "/bin/node", scriptPath: `${DIST}/hai.js`, forContainer: false })).toEqual(["/bin/node", `${DIST}/hair.js`]);
  });

  it.each<[string, Parameters<typeof hairCommand>[0]]>([
    ["a container, whose session cannot see hai's host install", { execPath: "/bin/node", scriptPath: `${DIST}/hai.js`, forContainer: true }],
    ["a script path with no directory", { execPath: "/bin/node", scriptPath: "hai.js", forContainer: false }],
    ["a script path that is not a built bin", { execPath: "/bin/node", scriptPath: "/src/bin/hai.ts", forContainer: false }]
  ])("should fall back to hair on PATH for %s", (_name, input) => {
    // Act / Assert
    expect(hairCommand(input)).toEqual(["hair"]);
  });
});

describe("haiScriptPath", () => {
  it.each<[string, string, string]>([
    ["hair's sibling, so a self-update re-execs hai rather than claiming a second conversation", `${DIST}/hair.js`, `${DIST}/hai.js`],
    ["a path that is already hai's", `${DIST}/hai.js`, `${DIST}/hai.js`],
    ["anything it does not recognise, left alone", "/opt/weird", "/opt/weird"]
  ])("should resolve %s", (_name, given, expected) => {
    // Act / Assert
    expect(haiScriptPath(given)).toBe(expected);
  });
});

describe("sessionRegistryHooks", () => {
  it("should build the hooks for a conversation", () => {
    // Arrange
    const seams = createFakeSeams({ execPath: "/bin/node", scriptPath: `${DIST}/hair.js` });

    // Act
    const hooks = sessionRegistryHooks(seams, { forwarded: ["-n", "pcs"], forContainer: false });

    // Assert
    expect(hooks?.[USER_PROMPT_SUBMIT]).toEqual([
      { hooks: [{ type: "command", command: `'/bin/node' '${DIST}/hair.js' hook UserPromptSubmit --name 'pcs'` }] }
    ]);
  });

  it("should build none for argv that starts no conversation, and say why", () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" } });

    // Act
    const hooks = sessionRegistryHooks(seams, { forwarded: ["-p", "x"], forContainer: false });

    // Assert
    expect(hooks).toBeUndefined();
    expect(seams.lines.join("")).toContain("starts no conversation worth resuming");
  });
});
