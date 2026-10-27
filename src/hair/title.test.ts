import { describe, expect, it } from "vitest";
import { createFakeFs, createFakeSeams } from "../__fixtures__/fake-seams.js";
import type { DirEntry } from "../system/fs.js";
import {
  AI_TITLE_TYPE,
  CUSTOM_TITLE_TYPE,
  findProjectDir,
  parseTitleRecord,
  pickTitle,
  projectsDir,
  readSessionTitle,
  scanTranscriptTitles,
  type TitleRecord,
  transcriptPath,
  transcriptSlug
} from "./title.js";

const HOME = "/home/dev";
const SESSION = "0d2a1f40-3c7e-4a1a-9f22-6b1d4c8e5a90";
const SLUG = "-home-dev-work-pcs-api";
const PROJECTS = `${HOME}/.claude/projects`;
const PROJECT_DIR = `${PROJECTS}/${SLUG}`;
const TRANSCRIPT = `${PROJECT_DIR}/${SESSION}.jsonl`;

/** The two record shapes, exactly as Claude Code appends them. */
const aiTitle = (title: string) => JSON.stringify({ type: AI_TITLE_TYPE, aiTitle: title, sessionId: SESSION });
const customTitle = (title: string) => JSON.stringify({ type: CUSTOM_TITLE_TYPE, customTitle: title, sessionId: SESSION });
const transcript = (...lines: string[]) => `${lines.join("\n")}\n`;
/** The bulk of a real transcript: tens of thousands of lines that are not title records. */
const chatter = JSON.stringify({ type: "user", message: { role: "user", content: "what does this do" } });

describe("transcriptSlug", () => {
  /**
   * The payload states which project directory the conversation is filed under, so there is
   * no reason to compute it — and a computed one goes wrong, `cwd` being able to move under
   * a session while Claude Code's slug is fixed at startup.
   */
  it("should take the slug out of the transcript path the payload carries", () => {
    // Act / Assert
    expect(transcriptSlug(TRANSCRIPT)).toBe(SLUG);
  });

  /**
   * The container's `~/.claude` is the host's bound at a different absolute path, so the
   * slug has to come out of whatever root the hook saw without that root mattering.
   */
  it("should answer the same slug for a path recorded inside a container session", () => {
    // Act / Assert
    expect(transcriptSlug(`/home/hmcts/.claude/projects/${SLUG}/${SESSION}.jsonl`)).toBe(SLUG);
  });

  it.each<[string, unknown]>([
    ["no transcript path at all", undefined],
    ["an empty transcript path", ""],
    ["a bare filename, which names no project directory", `${SESSION}.jsonl`],
    ["a root-level filename", `/${SESSION}.jsonl`]
  ])("should answer undefined for %s", (_name, path) => {
    // Act / Assert
    expect(transcriptSlug(path)).toBeUndefined();
  });

  /**
   * `parsePayload` establishes only that the payload is a non-array object, so the field is
   * a cast and not a fact — and `dirname` throws a `TypeError` on a non-string, which inside
   * `hookDecision` costs `runHook`'s catch-all the whole registration for that session
   * rather than just the slug. `hookDecision` is non-throwing over any JSON object, and this
   * is the row that keeps it so.
   */
  it.each<[string, unknown]>([
    ["a number, as a hand-written hook payload can carry", 42],
    ["a JSON null", null],
    ["an object, as a later Claude Code might send instead of a path", { path: TRANSCRIPT }],
    ["an array of paths", [TRANSCRIPT]],
    ["a boolean", true]
  ])("should answer undefined rather than throw for %s", (_name, path) => {
    // Act / Assert
    expect(transcriptSlug(path)).toBeUndefined();
  });
});

describe("the paths under ~/.claude/projects", () => {
  it("should name the transcript store, recomposed under whichever ~/.claude is being read", () => {
    // Act / Assert
    expect(projectsDir({ HOME })).toBe(PROJECTS);
    expect(projectsDir({ HOME: "/home/hmcts" })).toBe("/home/hmcts/.claude/projects");
  });

  it("should answer null when there is no HOME to find ~/.claude under", () => {
    // Act / Assert
    expect(projectsDir({})).toBeNull();
  });

  it("should name the conversation's transcript", () => {
    // Act / Assert
    expect(transcriptPath(PROJECT_DIR, SESSION)).toBe(TRANSCRIPT);
  });
});

describe("parseTitleRecord", () => {
  it.each<[string, string, TitleRecord]>([
    ["the name /rename appended", customTitle("hai-resume"), { kind: "custom", title: "hai-resume" }],
    ["the name Claude Code generated for itself", aiTitle("VS Code Claude session restore"), { kind: "ai", title: "VS Code Claude session restore" }]
  ])("should read %s", (_name, line, expected) => {
    // Act / Assert
    expect(parseTitleRecord(line)).toEqual(expected);
  });

  /**
   * A title record is a handful of lines in a file of tens of thousands, and every other
   * line has to be rejected cheaply — but on its `type`, not on what it happens to quote. A
   * conversation about this very file is full of lines that mention both names.
   */
  it("should reject a line that quotes a title type but is not one", () => {
    // Act / Assert
    expect(parseTitleRecord(JSON.stringify({ type: "user", message: 'the "custom-title" record is what /rename writes' }))).toBeNull();
  });

  it.each<[string, string]>([
    ["an ordinary transcript line, which is almost all of them", chatter],
    ["a half-written record, as a crash mid-append leaves one", '{"type":"custom-title","customTitle":'],
    ["a JSON string where an object was expected", '"ai-title"'],
    ["a record of a type nothing here reads", JSON.stringify({ type: "summary", summary: "ai-title" })],
    ["a custom-title record carrying no title", JSON.stringify({ type: CUSTOM_TITLE_TYPE, sessionId: SESSION })],
    ["an ai-title record whose title is not a string", JSON.stringify({ type: AI_TITLE_TYPE, aiTitle: 42 })]
  ])("should read %s as no title record", (_name, line) => {
    // Act / Assert
    expect(parseTitleRecord(line)).toBeNull();
  });

  /**
   * An empty title is a record and not an absence, and the difference is the whole of
   * `pickTitle`'s second half. Claude Code takes the **last** `custom-title` line and reads
   * `""` as "no custom title" — it deletes `custom-title.json` on one — so a title cleared
   * after a rename has to let the `ai-title` through. Dropping the record here kept the last
   * *non-empty* custom title, which brought the conversation back under the pre-clear name.
   */
  it.each<[string, string, TitleRecord]>([
    ["a cleared custom title", customTitle(""), { kind: "custom", title: "" }],
    ["a cleared ai title", aiTitle(""), { kind: "ai", title: "" }]
  ])("should read %s as a record saying the conversation has no name of that kind", (_name, line, expected) => {
    // Act / Assert
    expect(parseTitleRecord(line)).toEqual(expected);
  });
});

describe("pickTitle", () => {
  /**
   * Custom over ai, and **not** whichever came last. Measured in one live transcript: the
   * last `custom-title` record sits at byte 10,697,664 and the last `ai-title` at
   * 10,697,766, so the generated name is the later of the two — and yet the conversation's
   * real name is the custom one, `hai-resume`. Claude Code goes on generating a name after a
   * `/rename`, so a positional rule hands back the name the engineer already replaced.
   */
  it("should prefer the custom title even though the ai title came later in the file", () => {
    // Act / Assert
    expect(pickTitle({ custom: "hai-resume", ai: "VS Code Claude session restore" })).toBe("hai-resume");
  });

  it("should use the generated name when nobody has renamed the conversation", () => {
    // Act / Assert
    expect(pickTitle({ ai: "VS Code Claude session restore" })).toBe("VS Code Claude session restore");
  });

  /**
   * The case the custom-over-ai rule must not swallow. An empty last `custom-title` is the
   * person saying there is no chosen name any more — Claude Code reads it that way and would
   * show the `ai-title` — so a `??` over the two would shadow the name Claude Code itself is
   * displaying. Not seen in any of the 946 real conversations measured here, so this is
   * reachable in principle rather than observed; the asymmetry is that getting it wrong hands
   * back a name the engineer has already cleared.
   */
  it("should let the generated name through when the custom title was cleared", () => {
    // Act / Assert
    expect(pickTitle({ custom: "", ai: "VS Code Claude session restore" })).toBe("VS Code Claude session restore");
  });

  it.each<[string, Parameters<typeof pickTitle>[0]]>([
    ["named the conversation neither way", {}],
    ["had its custom title cleared and never generated one", { custom: "" }],
    ["has an empty record of both kinds", { custom: "", ai: "" }]
  ])("should answer undefined for a transcript that %s", (_name, found) => {
    // Act / Assert
    expect(pickTitle(found)).toBeUndefined();
  });
});

describe("scanTranscriptTitles", () => {
  /**
   * The records are append-only, so the last of each type is the current one. Both are kept
   * because the precedence between them is not positional.
   */
  it("should keep the last record of each type", async () => {
    // Arrange
    const seams = createFakeSeams({
      files: {
        [TRANSCRIPT]: transcript(
          aiTitle("a first guess"),
          chatter,
          customTitle("hai-resume"),
          chatter,
          aiTitle("a later guess"),
          customTitle("hai-resume-2"),
          chatter
        )
      }
    });

    // Act / Assert
    await expect(scanTranscriptTitles(seams, TRANSCRIPT)).resolves.toEqual({ custom: "hai-resume-2", ai: "a later guess" });
  });

  /**
   * One pass and no tail read: the records land near the end in practice, but a `/rename`
   * early in a long conversation that was never renamed again sits in the first megabyte of
   * a hundred, and density is an observation rather than a rule.
   */
  it("should find a title record at the very start of a long transcript", async () => {
    // Arrange
    const lines = [customTitle("named on the first prompt"), ...Array.from({ length: 5000 }, () => chatter)];
    const seams = createFakeSeams({ files: { [TRANSCRIPT]: transcript(...lines) } });

    // Act / Assert
    await expect(scanTranscriptTitles(seams, TRANSCRIPT)).resolves.toEqual({ custom: "named on the first prompt" });
  });

  /**
   * The last record of a type wins even when it is empty, which is what makes a cleared
   * title visible to `pickTitle` at all: keeping the last *non-empty* one would leave the
   * pre-clear name in place with nothing saying it had been cleared.
   */
  it("should let a cleared custom title replace the name it was clearing", async () => {
    // Arrange
    const seams = createFakeSeams({
      files: { [TRANSCRIPT]: transcript(customTitle("hai-resume"), chatter, aiTitle("a later guess"), customTitle("")) }
    });

    // Act / Assert
    await expect(scanTranscriptTitles(seams, TRANSCRIPT)).resolves.toEqual({ custom: "", ai: "a later guess" });
  });

  it("should answer nothing at all for a transcript that is not there, rather than throw", async () => {
    // Arrange
    const seams = createFakeSeams({});

    // Act / Assert
    await expect(scanTranscriptTitles(seams, TRANSCRIPT)).resolves.toEqual({});
  });
});

describe("findProjectDir", () => {
  /**
   * The recorded slug is Claude Code's own statement of where the conversation is filed, so
   * it is one `stat` and no scan at all. Asserted by making the scan unable to answer: if
   * anything here needed `listDir`, this would come back null.
   */
  it("should answer from the recorded slug without scanning the project directories", async () => {
    // Arrange
    const fs = createFakeFs({ [TRANSCRIPT]: transcript(chatter) });
    const listed: string[] = [];
    fs.listDir = async (path): Promise<DirEntry[]> => {
      listed.push(path);
      return [];
    };
    const seams = createFakeSeams({ env: { HOME }, fs });

    // Act / Assert
    await expect(findProjectDir(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBe(PROJECT_DIR);
    expect(listed).toEqual([]);
  });

  /**
   * No record written before the slug was recorded carries one, and that is the whole of an
   * engineer's existing registry. A session id is unique, so scanning for `<id>.jsonl` is
   * exact where deriving a slug from `cwd` was a guess.
   */
  it("should find the transcript by session id for a record that carries no slug", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [`${PROJECTS}/-somewhere-else/another-session.jsonl`]: transcript(chatter), [TRANSCRIPT]: transcript(chatter) }
    });

    // Act / Assert
    await expect(findProjectDir(seams, { sessionId: SESSION })).resolves.toBe(PROJECT_DIR);
  });

  /**
   * A recorded slug that names no transcript is not the end of the lookup: a project
   * directory Claude Code has since renamed, or a slug recorded against a different
   * `~/.claude`, both land here and the scan still answers.
   */
  it("should scan when the recorded slug does not hold the transcript", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [TRANSCRIPT]: transcript(chatter) } });

    // Act / Assert
    await expect(findProjectDir(seams, { slug: "-not-where-it-is", sessionId: SESSION })).resolves.toBe(PROJECT_DIR);
  });

  it("should ignore anything in the projects directory that is not a directory", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [`${PROJECTS}/${SESSION}.jsonl`]: transcript(chatter) } });

    // Act / Assert
    await expect(findProjectDir(seams, { sessionId: SESSION })).resolves.toBeNull();
  });

  it.each<[string, Parameters<typeof findProjectDir>[1], Record<string, string>]>([
    ["there is no transcript anywhere for this session", { sessionId: SESSION }, {}],
    ["there is no session id, which is what the scan looks for", { slug: SLUG }, { [TRANSCRIPT]: transcript(chatter) }],
    ["the session id is empty", { sessionId: "" }, { [TRANSCRIPT]: transcript(chatter) }],
    ["the recorded slug is empty, leaving nothing to join", { slug: "", sessionId: SESSION }, {}]
  ])("should answer null when %s", async (_name, input, files) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files });

    // Act / Assert
    await expect(findProjectDir(seams, input)).resolves.toBeNull();
  });

  it("should answer null when there is no HOME to find ~/.claude under", async () => {
    // Arrange
    const seams = createFakeSeams({ files: { [TRANSCRIPT]: transcript(chatter) } });

    // Act / Assert
    await expect(findProjectDir(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBeNull();
  });
});

describe("readSessionTitle", () => {
  it("should name a conversation from its transcript", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [TRANSCRIPT]: transcript(chatter, customTitle("hai-resume")) } });

    // Act / Assert
    await expect(readSessionTitle(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBe("hai-resume");
  });

  /**
   * The case that makes this worth reading at all: of the 946 real conversations on one
   * machine 194 carry an `ai-title` record against 66 a `custom-title` one, so most
   * conversations with a name have one nobody typed.
   */
  it("should name a conversation nobody renamed, from the title Claude Code generated", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [TRANSCRIPT]: transcript(chatter, aiTitle("VS Code Claude session restore")) } });

    // Act / Assert
    await expect(readSessionTitle(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBe("VS Code Claude session restore");
  });

  /**
   * End to end over the whole chain, because this is the one place the scan, the empty
   * record and the precedence meet: a conversation renamed and then cleared comes back under
   * the name Claude Code is itself showing, not the one it was renamed to.
   */
  it("should name a conversation whose custom title was cleared from the generated one", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [TRANSCRIPT]: transcript(aiTitle("VS Code Claude session restore"), customTitle("hai-resume"), chatter, customTitle("")) }
    });

    // Act / Assert
    await expect(readSessionTitle(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBe("VS Code Claude session restore");
  });

  /**
   * There is no second source. `custom-title.json` used to be a fallback on the strength of
   * "one conversation of the 1171 has the file and no `custom-title` record", and that one
   * conversation was a probe's own throwaway session. Across the 946 real ones, 62 have the
   * file and every one of them has the record beside it.
   */
  it("should read nothing but the transcript", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [TRANSCRIPT]: transcript(chatter), [`${PROJECT_DIR}/${SESSION}/custom-title.json`]: '{"customTitle":"hai-resume"}' }
    });

    // Act / Assert
    await expect(readSessionTitle(seams, { slug: SLUG, sessionId: SESSION })).resolves.toBeUndefined();
  });

  /**
   * Read from a hook, where a hook never breaks a session, and from a restore, where the
   * name is the least important thing happening. Every way of not having one is undefined.
   */
  it.each<[string, Record<string, string>, Parameters<typeof readSessionTitle>[1]]>([
    ["no transcript exists for this session at all", {}, { slug: SLUG, sessionId: SESSION }],
    ["the transcript names it neither way", { [TRANSCRIPT]: transcript(chatter) }, { slug: SLUG, sessionId: SESSION }],
    [
      "the transcript is half-written, as a crash mid-append leaves it",
      { [TRANSCRIPT]: `${JSON.stringify({ type: CUSTOM_TITLE_TYPE, customTitle: "hai-resume" }).slice(0, 30)}` },
      { slug: SLUG, sessionId: SESSION }
    ],
    ["there is no session id to look anything up by", { [TRANSCRIPT]: transcript(customTitle("hai-resume")) }, { slug: SLUG }]
  ])("should answer undefined when %s", async (_name, files, input) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files });

    // Act / Assert
    await expect(readSessionTitle(seams, input)).resolves.toBeUndefined();
  });
});
