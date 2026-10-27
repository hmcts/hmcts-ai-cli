import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { projectSlug } from "../container/session.js";
import { customTitlePath, parseCustomTitle, readCustomTitle, transcriptSlug } from "./title.js";

const HOME = "/home/dev";
const CWD = "/home/dev/work/pcs-api";
const SLUG = projectSlug(CWD);
const SESSION = "0d2a1f40-3c7e-4a1a-9f22-6b1d4c8e5a90";
const TITLE = `${HOME}/.claude/projects/${SLUG}/${SESSION}/custom-title.json`;

describe("transcriptSlug", () => {
  /**
   * The payload states which project directory the conversation is filed under, so there is
   * no reason to compute it — and a computed one goes wrong, `cwd` being able to move under
   * a session while Claude Code's slug is fixed at startup.
   */
  it("should take the slug out of the transcript path the payload carries", () => {
    // Act / Assert
    expect(transcriptSlug(`${HOME}/.claude/projects/${SLUG}/${SESSION}.jsonl`)).toBe(SLUG);
  });

  /**
   * The container's `~/.claude` is the host's bound at a different absolute path, so the
   * slug has to come out of whatever root the hook saw without that root mattering.
   */
  it("should answer the same slug for a path recorded inside a container session", () => {
    // Act / Assert
    expect(transcriptSlug(`/home/hmcts/.claude/projects/${SLUG}/${SESSION}.jsonl`)).toBe(SLUG);
  });

  it.each<[string, string | undefined]>([
    ["no transcript path at all", undefined],
    ["an empty transcript path", ""],
    ["a bare filename, which names no project directory", `${SESSION}.jsonl`],
    ["a root-level filename", `/${SESSION}.jsonl`]
  ])("should answer undefined for %s", (_name, path) => {
    // Act / Assert
    expect(transcriptSlug(path)).toBeUndefined();
  });
});

describe("customTitlePath", () => {
  it("should name Claude Code's own per-conversation title file", () => {
    // Act / Assert
    expect(customTitlePath({ HOME }, { slug: SLUG, sessionId: SESSION })).toBe(TITLE);
  });

  /**
   * The recorded slug is what Claude Code itself filed the conversation under; a slug
   * derived from `cwd` is a guess that is wrong as soon as the session changes directory.
   */
  it("should prefer the recorded slug over one derived from cwd", () => {
    // Act / Assert
    expect(customTitlePath({ HOME }, { slug: SLUG, cwd: "/somewhere-it-cd-ed-to", sessionId: SESSION })).toBe(TITLE);
  });

  /**
   * The fallback for the records written before a slug was recorded — which is every line of
   * an engineer's existing registry, and those are killed sessions that will never fire
   * another hook to fill it in. It is safe because the session id is the *leaf*: a wrong slug
   * names a directory that does not exist, so this can only miss, never answer with another
   * conversation's title.
   */
  it("should fall back to deriving the slug from cwd for a record that carries none", () => {
    // Act / Assert
    expect(customTitlePath({ HOME }, { cwd: CWD, sessionId: SESSION })).toBe(TITLE);
  });

  /**
   * The derived form has to be byte-identical to Claude Code's or the fallback silently
   * misses, so these are real directory names off this machine rather than a restatement of
   * the regex: a plain path, one whose last segment holds dots, and a worktree path carrying
   * a dot-directory and dashes together.
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
    ["there is no HOME to find ~/.claude under", [{}, { slug: SLUG, sessionId: SESSION }]],
    ["the record carries neither a slug nor a cwd", [{ HOME }, { sessionId: SESSION }]],
    ["there is no session id, which is the leaf of the path", [{ HOME }, { slug: SLUG }]]
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

describe("readCustomTitle", () => {
  it("should read the stored title for a conversation", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [TITLE]: '{"customTitle":"hai-resume"}' } });

    // Act / Assert
    await expect(readCustomTitle(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBe("hai-resume");
  });

  it.each<[string, Record<string, string>, Parameters<typeof readCustomTitle>[1]]>([
    ["no title file was ever written, which is every conversation nobody has renamed", {}, { slug: SLUG, sessionId: SESSION }],
    ["the path cannot be derived at all", {}, {}]
  ])("should answer undefined when %s", async (_name, files, input) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files });

    // Act / Assert
    await expect(readCustomTitle(seams, input)).resolves.toBeUndefined();
  });
});
