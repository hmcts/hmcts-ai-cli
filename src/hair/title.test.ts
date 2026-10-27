import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { projectSlug } from "../container/session.js";
import { BEL, customTitlePath, DISABLE_TITLE_ENV, OSC_TITLE_PREFIX, parseCustomTitle, readCustomTitle, titleDecision, writeTerminalTitle } from "./title.js";

const HOME = "/home/dev";
const CWD = "/home/dev/work/pcs-api";
const SESSION = "0d2a1f40-3c7e-4a1a-9f22-6b1d4c8e5a90";
const TITLE = `${HOME}/.claude/projects/${projectSlug(CWD)}/${SESSION}/custom-title.json`;

describe("customTitlePath", () => {
  it("should name Claude Code's own per-conversation title file", () => {
    // Act / Assert
    expect(customTitlePath({ HOME }, { cwd: CWD, sessionId: SESSION })).toBe(TITLE);
  });

  /**
   * The transform has to be byte-identical to Claude Code's or every lookup silently
   * misses, so these are real directory names off this machine rather than a restatement
   * of the regex: a plain path, one whose last segment holds dots, and a worktree path
   * carrying a dot-directory and dashes together.
   */
  it.each<[string, string]>([
    ["/home/linus/Work/solirius/hmcts", "-home-linus-Work-solirius-hmcts"],
    ["/home/linus/Work/eco-rewards/ecorewards.co.uk", "-home-linus-Work-eco-rewards-ecorewards-co-uk"],
    [
      "/home/linus/Work/eco-rewards/eco-rewards-hub/.claude/worktrees/deploy-memory-fix",
      "-home-linus-Work-eco-rewards-eco-rewards-hub--claude-worktrees-deploy-memory-fix"
    ]
  ])("should slug %s the way the directory on disk is named", (cwd, slug) => {
    // Act / Assert
    expect(customTitlePath({ HOME }, { cwd, sessionId: SESSION })).toBe(`${HOME}/.claude/projects/${slug}/${SESSION}/custom-title.json`);
  });

  it.each<[string, Parameters<typeof customTitlePath>]>([
    ["there is no HOME to find ~/.claude under", [{}, { cwd: CWD, sessionId: SESSION }]],
    ["the payload carried no cwd, so the project slug cannot be derived", [{ HOME }, { sessionId: SESSION }]],
    ["the payload carried no session id", [{ HOME }, { cwd: CWD }]]
  ])("should answer null when %s", (_name, args) => {
    // Act / Assert
    expect(customTitlePath(...args)).toBeNull();
  });
});

describe("parseCustomTitle", () => {
  it("should read the name /rename persisted", () => {
    // Act / Assert
    expect(parseCustomTitle('{"customTitle":"hai-resume"}')).toBe("hai-resume");
  });

  /**
   * Read from a hook, where a hook never breaks a session: every malformed shape is a
   * silent no-name. The `null` row is the one that would throw on a property read.
   */
  it.each<[string, string | null]>([
    ["no file at all", null],
    ["half a file, as a crash mid-write leaves one", '{"customTitle":'],
    ["a JSON null", "null"],
    ["a JSON string where an object was expected", '"hai-resume"'],
    ["an object with no customTitle", '{"other":"hai-resume"}'],
    ["a customTitle that is not a string", '{"customTitle":42}'],
    ["an empty customTitle", '{"customTitle":""}']
  ])("should read %s as no name", (_name, text) => {
    // Act / Assert
    expect(parseCustomTitle(text)).toBeUndefined();
  });
});

describe("titleDecision", () => {
  /**
   * The exact bytes, terminator included. `OSC 0` is `ESC ] 0 ; <text> BEL`, captured from
   * a live Claude Code session under a pty: a missing or swapped terminator leaves the
   * title unset and the rest of the stream being eaten as part of the sequence.
   */
  it("should emit ESC ] 0 ; name BEL", () => {
    // Act
    const outcome = titleDecision({ name: "pcs", isTty: true, env: {} });

    // Assert
    expect(outcome).toMatchObject({ action: "write", sequence: "\u001b]0;pcs\u0007" });
    expect(`${OSC_TITLE_PREFIX}pcs${BEL}`).toBe("\u001b]0;pcs\u0007");
  });

  it.each<[string, Parameters<typeof titleDecision>[0]]>([
    ["the record has no name, so blanking the title would be worse than leaving it", { isTty: true, env: {} }],
    ["the name is empty", { name: "", isTty: true, env: {} }],
    ["stdout is a pipe or a captured log rather than a terminal", { name: "pcs", isTty: false, env: {} }],
    ["the engineer told Claude Code itself not to touch their title", { name: "pcs", isTty: true, env: { [DISABLE_TITLE_ENV]: "1" } }]
  ])("should write nothing when %s", (_name, input) => {
    // Act / Assert
    expect(titleDecision(input)).toMatchObject({ action: "skip" });
  });

  /**
   * The variable is Claude Code's, not hai's, so the `HAI_*` rule that a flag is on only
   * at exactly `1` is the wrong reading of it: any value the engineer set means they meant
   * it, and going round their opt-out on Claude Code's behalf is the one thing this must
   * not do.
   */
  it("should honour the opt-out whatever value it was set to, the variable not being hai's", () => {
    // Act / Assert
    expect(titleDecision({ name: "pcs", isTty: true, env: { [DISABLE_TITLE_ENV]: "true" } })).toMatchObject({ action: "skip" });
    expect(titleDecision({ name: "pcs", isTty: true, env: { [DISABLE_TITLE_ENV]: "" } })).toMatchObject({ action: "write" });
  });

  /**
   * An OSC string runs to its terminator, so a BEL or an ESC inside the name would cut the
   * sequence short and leave the remainder as input to the terminal.
   */
  it("should drop the control characters out of a name rather than let them end the sequence early", () => {
    // Act / Assert
    expect(titleDecision({ name: `pcs${BEL}; rm -rf /`, isTty: true, env: {} })).toMatchObject({ action: "write", sequence: "\u001b]0;pcs; rm -rf /\u0007" });
    expect(titleDecision({ name: "\n\t", isTty: true, env: {} })).toMatchObject({ action: "skip" });
  });
});

describe("readCustomTitle", () => {
  it("should read the stored title for a conversation", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [TITLE]: '{"customTitle":"hai-resume"}' } });

    // Act / Assert
    await expect(readCustomTitle(seams, { cwd: CWD, sessionId: SESSION })).resolves.toBe("hai-resume");
  });

  it.each<[string, Record<string, string>, Parameters<typeof readCustomTitle>[1]]>([
    ["no title file was ever written, which is every conversation nobody has renamed", {}, { cwd: CWD, sessionId: SESSION }],
    ["the path cannot be derived at all", {}, {}]
  ])("should answer undefined when %s", async (_name, files, input) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files });

    // Act / Assert
    await expect(readCustomTitle(seams, input)).resolves.toBeUndefined();
  });
});

describe("writeTerminalTitle", () => {
  it("should put the sequence on stdout and nothing through the logger", () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" } });

    // Act
    writeTerminalTitle(seams, "pcs");

    // Assert
    // Not one byte of the sequence may go through `createLogger`, which redacts, prefixes
    // `hai: ` and appends a newline.
    expect(seams.out).toEqual(["\u001b]0;pcs\u0007"]);
    expect(seams.lines.join("")).not.toContain(OSC_TITLE_PREFIX);
  });

  it.each<[string, Parameters<typeof createFakeSeams>[0], string | undefined]>([
    ["the conversation has no name", {}, undefined],
    ["stdout is not a terminal", { stdoutIsTty: false }, "pcs"],
    ["the engineer opted out of title writes", { env: { [DISABLE_TITLE_ENV]: "1" } }, "pcs"]
  ])("should leave the terminal alone when %s", (_name, over, title) => {
    // Arrange
    const seams = createFakeSeams(over);

    // Act
    writeTerminalTitle(seams, title);

    // Assert
    expect(seams.out).toEqual([]);
  });
});
