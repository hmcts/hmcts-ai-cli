import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../system/state-dir.js";
import { CACHE_FILE, CACHE_TTL_MS, readAuthCache, writeAuthCache } from "./auth-cache.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const KEY = "tenant:dev@hmcts.net";

const FRESH = { [KEY]: { group: { at: FIXED_NOW - 1000, isMember: true } } };

function seamsWith(contents?: string) {
  return createFakeSeams({ env: { HOME }, files: contents === undefined ? {} : { [CACHE_PATH]: contents } });
}

describe("readAuthCache", () => {
  it("should return a fresh group entry", async () => {
    // Arrange
    const seams = seamsWith(JSON.stringify(FRESH));

    // Act
    const entry = await readAuthCache(seams, KEY);

    // Assert
    expect(entry?.group).toMatchObject({ isMember: true });
  });

  it("should return nothing when there is no cache file", async () => {
    // Act / Assert
    expect(await readAuthCache(seamsWith(), KEY)).toBeNull();
  });

  it("should return nothing for an unparseable cache rather than throw", async () => {
    // Act / Assert
    expect(await readAuthCache(seamsWith("not json"), KEY)).toBeNull();
  });

  it.each([
    ["an unknown key", JSON.stringify(FRESH), "other:user"],
    ["a null entry", JSON.stringify({ [KEY]: null }), KEY],
    ["a non-object entry", JSON.stringify({ [KEY]: "bedrock" }), KEY]
  ])("should return nothing for %s", async (_name, contents, key) => {
    // Act / Assert
    expect(await readAuthCache(seamsWith(contents), key)).toBeNull();
  });

  it.each([
    ["is older than the 12h ttl", { at: FIXED_NOW - CACHE_TTL_MS, isMember: true }],
    ["carries no timestamp", { isMember: true }],
    ["carries an unparseable timestamp", { at: "yesterday", isMember: true }],
    ["holds a membership that is not a boolean", { at: FIXED_NOW, isMember: "yes" }]
  ])("should drop a group entry that %s", async (_name, group) => {
    // Act
    const entry = await readAuthCache(seamsWith(JSON.stringify({ [KEY]: { group } })), KEY);

    // Assert
    expect(entry?.group).toBeUndefined();
  });
});

describe("writeAuthCache", () => {
  it("should create the state directory 0700 and the file 0600", async () => {
    // Arrange
    const seams = seamsWith();

    // Act
    await writeAuthCache(seams, KEY, { group: { at: FIXED_NOW, isMember: true } });

    // Assert
    expect(seams.fs.modes.get(`${HOME}/.local/state/hai`)).toBe(STATE_DIR_MODE);
    expect(seams.fs.modes.get(CACHE_PATH)).toBe(STATE_FILE_MODE);
  });

  it("should keep other identities' entries", async () => {
    // Arrange
    const seams = seamsWith(JSON.stringify({ "other:user": { group: { at: FIXED_NOW, isMember: false } } }));

    // Act
    await writeAuthCache(seams, KEY, { group: { at: FIXED_NOW, isMember: true } });

    // Assert
    const written = JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}");
    expect(Object.keys(written).sort()).toEqual(["other:user", KEY]);
  });

  it("should start afresh when the existing cache is unparseable", async () => {
    // Arrange
    const seams = seamsWith("not json");

    // Act
    await writeAuthCache(seams, KEY, { group: { at: FIXED_NOW, isMember: true } });

    // Assert
    expect(Object.keys(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}"))).toEqual([KEY]);
  });

  it("should never write a credential", async () => {
    // Arrange
    const seams = seamsWith();

    // Act
    await writeAuthCache(seams, KEY, { group: { at: FIXED_NOW, isMember: true } });

    // Assert
    const written = seams.fs.store.get(CACHE_PATH) ?? "";
    expect(written).not.toMatch(/ABSK|sk-ant-|accessToken/);
  });
});
