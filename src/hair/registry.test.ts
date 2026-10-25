import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import {
  appendRecord,
  COMPACTION_THRESHOLD,
  claimPath,
  compacted,
  compactRegistry,
  lineCount,
  parseRecord,
  parseRegistry,
  RESTORE_WINDOW_MS,
  readRegistry,
  recordLine,
  registryDir,
  registryPath,
  retired,
  type SessionRecord,
  shouldCompact
} from "./registry.js";

const HOME = "/home/dev";
const REGISTRY = `${HOME}/.claude/sessions.jsonl`;

const DAY = 24 * 60 * 60 * 1000;

const open = (over: Partial<SessionRecord> = {}): SessionRecord => ({ sessionId: "a", cwd: "/work", state: "open", at: FIXED_NOW, pid: 100, ...over });

describe("registryPath", () => {
  it("should put the registry under ~/.claude, where the container and the host both see it", () => {
    // Act / Assert
    expect(registryPath({ HOME })).toBe(REGISTRY);
    expect(claimPath({ HOME }, "abc")).toBe(`${HOME}/.claude/hair-claims/abc.json`);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["unset", {}],
    ["empty", { HOME: "" }]
  ])("should have nowhere to keep it when HOME is %s", (_name, env) => {
    // Act / Assert
    expect(registryDir(env)).toBeNull();
    expect(registryPath(env)).toBeNull();
    expect(claimPath(env, "abc")).toBeNull();
  });
});

describe("parseRegistry", () => {
  it("should let a later line win, so a re-registration and a tombstone are both idempotent", () => {
    // Arrange
    const text = [recordLine(open({ pid: 1 })), recordLine(open({ pid: 2 })), recordLine(open({ sessionId: "b" }))].join("");

    // Act
    const records = parseRegistry(text);

    // Assert
    expect(records).toEqual([open({ pid: 2 }), open({ sessionId: "b" })]);
  });

  it("should read nothing out of a registry that is not there", () => {
    // Act / Assert
    expect(parseRegistry(null)).toEqual([]);
    expect(lineCount(null)).toBe(0);
  });

  it.each<[string, string]>([
    ["a blank line", "   "],
    ["half a line, which is what a torn write leaves", '{"sessionId":"a","cwd"'],
    ["a line that is not an object", '"a string"'],
    ["a record with no session id", '{"cwd":"/work","state":"open"}'],
    ["a record with an empty session id", '{"sessionId":"","cwd":"/work","state":"open"}'],
    ["a record with no cwd, which hair would have nowhere to resume from", '{"sessionId":"a","state":"open"}'],
    ["a record in a state this version does not know", '{"sessionId":"a","cwd":"/work","state":"paused"}']
  ])("should drop %s", (_name, line) => {
    // Act / Assert
    expect(parseRecord(line)).toBeNull();
  });

  it("should default the numbers and drop an empty name rather than carry it", () => {
    // Act
    const record = parseRecord('{"sessionId":"a","cwd":"/work","state":"open","name":"","at":"nonsense"}');

    // Assert
    expect(record).toEqual({ sessionId: "a", cwd: "/work", state: "open", at: 0, pid: 0 });
  });

  it("should keep the name and the namespace the pid belongs to", () => {
    // Act / Assert
    expect(parseRecord('{"sessionId":"a","cwd":"/work","state":"open","name":"pcs","at":5,"pid":9,"host":"a1b2c3","container":"hai-pcs-1"}')).toEqual({
      sessionId: "a",
      cwd: "/work",
      state: "open",
      at: 5,
      pid: 9,
      name: "pcs",
      host: "a1b2c3",
      container: "hai-pcs-1"
    });
  });

  it("should still read a record an earlier release wrote with no namespace at all", () => {
    // Act
    const parsed = parseRecord('{"sessionId":"a","cwd":"/work","state":"open","at":5,"pid":9}');

    // Assert
    expect(parsed).toEqual({ sessionId: "a", cwd: "/work", state: "open", at: 5, pid: 9 });
    expect(Object.keys(parsed!)).not.toContain("host");
  });

  it.each<[string, string]>([
    ["an empty host", '{"sessionId":"a","cwd":"/work","state":"open","host":""}'],
    ["a host that is not a string", '{"sessionId":"a","cwd":"/work","state":"open","host":7}']
  ])("should drop %s rather than carry a field it could not fill", (_name, line) => {
    // Act / Assert
    expect(Object.keys(parseRecord(line)!)).not.toContain("host");
  });
});

describe("compacted", () => {
  it("should keep only the open records, a tombstone existing to cancel a registration", () => {
    // Act / Assert
    expect(compacted([open(), open({ sessionId: "b", state: "closed" })], FIXED_NOW)).toBe(recordLine(open()));
  });

  /**
   * Only an allow-listed reason writes a tombstone now, so every signal-killed session and
   * every `/resume` departure is open for ever unless something retires it. Without this
   * the file never shrinks, `probeLiveness` spawns a `ps` per record on every `hair --list`
   * for the rest of the engineer's career, and an open set past the threshold makes a
   * compaction unable to drop anything at all.
   */
  it("should drop an open record nothing has touched inside the window, nothing else retiring one", () => {
    // Arrange
    const fresh = open({ sessionId: "yesterday", at: FIXED_NOW - DAY });
    const stale = open({ sessionId: "three-weeks-ago", at: FIXED_NOW - 21 * DAY });

    // Act / Assert
    expect(compacted([fresh, stale], FIXED_NOW)).toBe(recordLine(fresh));
  });

  it.each<[string, number, boolean]>([
    ["inside the window", RESTORE_WINDOW_MS - 1, false],
    ["exactly at the window, which is still inside it", RESTORE_WINDOW_MS, false],
    ["one tick past the window", RESTORE_WINDOW_MS + 1, true]
  ])("should read a record last touched %s as retired=%s", (_name, elapsed, expected) => {
    // Act / Assert
    expect(retired(open({ at: FIXED_NOW - elapsed }), FIXED_NOW)).toBe(expected);
  });
});

/**
 * The rewrite is the one operation that can lose a concurrent append, so it has to stay
 * rare. A length test alone was enough while every conversation ended in a tombstone; with
 * open records permanent it is not, because an open set bigger than the threshold leaves
 * `lines >= COMPACTION_THRESHOLD` true while the rewrite drops nothing — and the rewrite
 * would then run on every single hook.
 */
describe("shouldCompact", () => {
  it.each<[string, number, number, boolean]>([
    ["a short file, whatever it would keep", COMPACTION_THRESHOLD - 1, 1, false],
    ["a long file the rewrite would more than halve", COMPACTION_THRESHOLD, 10, true],
    ["a long file the rewrite would exactly halve", COMPACTION_THRESHOLD, COMPACTION_THRESHOLD / 2, true],
    ["a long file whose open set is most of it, where the rewrite is not worth its risk", COMPACTION_THRESHOLD, COMPACTION_THRESHOLD / 2 + 1, false],
    ["a long file that is entirely open records, the case that used to compact on every hook", COMPACTION_THRESHOLD, COMPACTION_THRESHOLD, false]
  ])("should decide %s", (_name, lines, keeping, expected) => {
    // Act / Assert
    expect(shouldCompact({ lines, keeping })).toBe(expected);
  });
});

describe("the registry's I/O", () => {
  it("should append one line and count what is there", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [REGISTRY]: recordLine(open({ sessionId: "b" })) } });

    // Act
    await appendRecord(seams, open());
    const read = await readRegistry(seams);

    // Assert
    expect(seams.fs.modes.get(REGISTRY)).toBe(0o600);
    expect(read.lines).toBe(2);
    expect(read.records.map((record) => record.sessionId)).toEqual(["b", "a"]);
  });

  it("should write nothing at all when there is no HOME to write under", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {} });

    // Act
    await appendRecord(seams, open());
    await compactRegistry(seams, [open()]);

    // Assert
    expect(seams.fs.store.size).toBe(0);
    expect(await readRegistry(seams)).toEqual({ records: [], lines: 0 });
  });

  it("should compact through a rename, so a reader never sees half a registry", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [REGISTRY]: `${recordLine(open())}${recordLine(open({ sessionId: "b", state: "closed" }))}` } });

    // Act
    await compactRegistry(seams, parseRegistry(seams.fs.store.get(REGISTRY)!));

    // Assert
    expect(seams.fs.store.get(REGISTRY)).toBe(recordLine(open()));
    expect([...seams.fs.store.keys()].filter((key) => key.endsWith(".tmp"))).toEqual([]);
  });

  /**
   * One shared `.tmp` would let two sessions compacting at once write different content
   * to the same path before either renamed it — the half-written file the rename exists to
   * rule out.
   */
  it("should write to a temporary file of its own, not one every session shares", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, pid: 4242 });
    const renames: string[] = [];
    seams.fs.rename = async (from) => {
      renames.push(from);
    };

    // Act
    await compactRegistry(seams, [open()]);

    // Assert
    expect(renames).toEqual([`${REGISTRY}.4242.tmp`]);
  });
});
