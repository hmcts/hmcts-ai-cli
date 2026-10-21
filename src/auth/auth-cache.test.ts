import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../system/state-dir.js";
import { CACHE_FILE, CACHE_TTL_MS, readAuthCache, writeAuthCache } from "./auth-cache.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const KEY = "tenant:dev@hmcts.net";

const FRESH = {
  [KEY]: {
    route: { at: FIXED_NOW - 1000, route: "bedrock", credentialSource: "agent-hub", reasons: ["agent-hub holds a Bedrock API key for you"] },
    group: { at: FIXED_NOW - 1000, isMember: true }
  }
};

function seamsWith(contents?: string) {
  return createFakeSeams({ env: { HOME }, files: contents === undefined ? {} : { [CACHE_PATH]: contents } });
}

describe("readAuthCache", () => {
  it("should return a fresh route and group entry", async () => {
    // Arrange
    const seams = seamsWith(JSON.stringify(FRESH));

    // Act
    const entry = await readAuthCache(seams, KEY);

    // Assert
    expect(entry?.route).toMatchObject({ route: "bedrock", credentialSource: "agent-hub" });
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

  it("should drop a route entry older than the 12h ttl", async () => {
    // Arrange
    const stale = { [KEY]: { route: { ...FRESH[KEY].route, at: FIXED_NOW - CACHE_TTL_MS } } };

    // Act
    const entry = await readAuthCache(seamsWith(JSON.stringify(stale)), KEY);

    // Assert
    expect(entry?.route).toBeUndefined();
  });

  it("should drop a stale group entry", async () => {
    // Arrange
    const stale = { [KEY]: { group: { at: FIXED_NOW - CACHE_TTL_MS - 1, isMember: true } } };

    // Act
    const entry = await readAuthCache(seamsWith(JSON.stringify(stale)), KEY);

    // Assert
    expect(entry?.group).toBeUndefined();
  });

  it.each([
    ["an unknown route name", { route: { at: FIXED_NOW, route: "magic", credentialSource: "env", reasons: [] } }],
    ["a non-string route", { route: { at: FIXED_NOW, route: 7, credentialSource: "env", reasons: [] } }],
    ["no credential source", { route: { at: FIXED_NOW, route: "bedrock", reasons: [] } }],
    ["no timestamp", { route: { route: "bedrock", credentialSource: "env", reasons: [] } }],
    ["an unparseable timestamp", { route: { at: "yesterday", route: "bedrock", credentialSource: "env", reasons: [] } }]
  ])("should drop a route entry with %s", async (_name, entry) => {
    // Act
    const result = await readAuthCache(seamsWith(JSON.stringify({ [KEY]: entry })), KEY);

    // Assert
    expect(result?.route).toBeUndefined();
  });

  it.each([
    ["reasons that are not an array", { at: FIXED_NOW, route: "bedrock", credentialSource: "env", reasons: "because" }, []],
    ["reasons holding non-strings", { at: FIXED_NOW, route: "bedrock", credentialSource: "env", reasons: ["a", 7] }, ["a"]]
  ])("should repair %s", async (_name, route, expected) => {
    // Act
    const result = await readAuthCache(seamsWith(JSON.stringify({ [KEY]: { route } })), KEY);

    // Assert
    expect(result?.route?.reasons).toEqual(expected);
  });

  it("should drop a group entry whose membership is not a boolean", async () => {
    // Act
    const result = await readAuthCache(seamsWith(JSON.stringify({ [KEY]: { group: { at: FIXED_NOW, isMember: "yes" } } })), KEY);

    // Assert
    expect(result?.group).toBeUndefined();
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
    await writeAuthCache(seams, KEY, { route: { at: FIXED_NOW, route: "bedrock", credentialSource: "agent-hub", reasons: [] } });

    // Assert
    const written = seams.fs.store.get(CACHE_PATH) ?? "";
    expect(written).not.toMatch(/ABSK|sk-ant-|accessToken/);
  });
});
