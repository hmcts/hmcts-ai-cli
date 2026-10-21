import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { PACKAGE_NAME, REGISTRY_ARG } from "./package-manager.js";
import { CACHE_FILE, CACHE_TTL_MS, maybeSelfUpdate, PACKUMENT_URL, packageRoot, readCurrentVersion, skipUpdateCheck } from "./self-update.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const CURRENT = "0.1.0";
const LATEST = "0.2.0";

const installs = () => ({ code: 0 });

function feed(version: string | null, status = 200) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (version === null) {
      throw new Error("fetch failed");
    }
    return new Response(JSON.stringify({ "dist-tags": { latest: version } }), { status });
  };
  return { requests, fetch };
}

const headersOf = (init: RequestInit | undefined) => new Headers(init?.headers ?? {});

describe("packageRoot", () => {
  it("should point at the installed package, not at src", () => {
    // Act / Assert
    expect(packageRoot()).toMatch(/hmcts-ai-cli\/$/);
  });
});

describe("readCurrentVersion", () => {
  it("should read the version out of the package manifest", async () => {
    // Act
    const version = await readCurrentVersion(createFakeSeams());

    // Assert — the fake fs holds nothing, so this is the fallback.
    expect(version).toBe("0.0.0");
  });

  it("should read a real manifest when one is there", async () => {
    // Arrange
    const seams = createFakeSeams();
    const path = `${packageRoot()}package.json`;
    seams.fs.store.set(path, JSON.stringify({ version: "9.9.9" }));

    // Act / Assert
    expect(await readCurrentVersion(seams)).toBe("9.9.9");
  });

  it.each([
    ["an unparseable manifest", "not json"],
    ["a manifest with no version", "{}"]
  ])("should fall back to 0.0.0 given %s", async (_name, contents) => {
    // Arrange
    const seams = createFakeSeams();
    seams.fs.store.set(`${packageRoot()}package.json`, contents);

    // Act / Assert
    expect(await readCurrentVersion(seams)).toBe("0.0.0");
  });
});

describe("skipUpdateCheck", () => {
  const skipped = (reason: string | null) => ({ skip: true, reason });

  it.each([
    ["nothing is set and the build is a published one", {}, CURRENT, { skip: false, reason: null }],
    ["HAI_NO_UPDATE=1", { HAI_NO_UPDATE: "1" }, CURRENT, skipped("HAI_NO_UPDATE=1, so the update check is skipped")],
    ["HAI_UPDATED=1", { HAI_UPDATED: "1" }, CURRENT, skipped(null)],
    ["HAI_DRY_RUN=1", { HAI_DRY_RUN: "1" }, CURRENT, skipped("HAI_DRY_RUN=1, so the update check is skipped")],
    ["HAI_OFFLINE=1", { HAI_OFFLINE: "1" }, CURRENT, skipped("HAI_OFFLINE=1, so the update check is skipped")],
    ["the running build is an unpublished 0.0.0", {}, "0.0.0", skipped("running an unpublished 0.0.0 build, so the update check is skipped")],
    ["HAI_NO_UPDATE=1 outranks HAI_UPDATED=1", { HAI_NO_UPDATE: "1", HAI_UPDATED: "1" }, CURRENT, skipped("HAI_NO_UPDATE=1, so the update check is skipped")],
    ["HAI_UPDATED=1 outranks HAI_DRY_RUN=1", { HAI_UPDATED: "1", HAI_DRY_RUN: "1" }, CURRENT, skipped(null)],
    ["HAI_DRY_RUN=1 outranks HAI_OFFLINE=1", { HAI_DRY_RUN: "1", HAI_OFFLINE: "1" }, CURRENT, skipped("HAI_DRY_RUN=1, so the update check is skipped")],
    ["HAI_OFFLINE=1 outranks an unpublished build", { HAI_OFFLINE: "1" }, "0.0.0", skipped("HAI_OFFLINE=1, so the update check is skipped")],
    ["a flag is set to something other than 1", { HAI_DRY_RUN: "0" }, CURRENT, { skip: false, reason: null }]
  ])("should decide given %s", (_name, env, currentVersion, expected) => {
    // Act / Assert
    expect(skipUpdateCheck({ env, currentVersion })).toEqual(expected);
  });
});

describe("the version check", () => {
  it("should percent-encode the scope separator in the packument path", () => {
    // Act / Assert
    expect(PACKUMENT_URL).toBe("https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/@hmcts-cft%2Fhai-cli");
  });

  it("should read the feed anonymously, with no authorization header and no az call", async () => {
    // Arrange — the feed allows anonymous reads, so nothing has to be minted first.
    const { requests, fetch } = feed(LATEST);
    const seams = createFakeSeams({ env: { HOME }, fetch, respond: installs });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(requests.map((request) => request.url)).toEqual([PACKUMENT_URL]);
    expect(headersOf(requests[0]?.init).has("authorization")).toBe(false);
    expect(seams.runner.calls.map((call) => call.argv[0])).not.toContain("az");
  });
});

describe("maybeSelfUpdate", () => {
  it("should install the new version with the feed as --registry and ask to be re-exec'd", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, fetch: feed(LATEST).fetch, respond: installs });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(outcome.reExec).toBe(true);
    expect(seams.runner.calls[0]?.argv).toEqual(["npm", "install", "-g", PACKAGE_NAME, REGISTRY_ARG]);
    expect(seams.lines.join("")).toContain(`updating ${PACKAGE_NAME} 0.1.0 -> 0.2.0`);
  });

  it.each([
    ["HAI_NO_UPDATE=1", { HAI_NO_UPDATE: "1" }, CURRENT],
    ["HAI_UPDATED=1", { HAI_UPDATED: "1" }, CURRENT],
    ["HAI_OFFLINE=1", { HAI_OFFLINE: "1" }, CURRENT],
    ["HAI_DRY_RUN=1", { HAI_DRY_RUN: "1" }, CURRENT],
    ["an unpublished 0.0.0 build", {}, "0.0.0"]
  ])("should be completely inert under %s: no fetch, no install, no cache write", async (_name, env, currentVersion) => {
    // Arrange
    const { requests, fetch } = feed(LATEST);
    const seams = createFakeSeams({ env: { HOME, ...env }, fetch, respond: installs });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion });

    // Assert
    expect(outcome.reExec).toBe(false);
    expect(requests).toEqual([]);
    expect(seams.runner.calls).toEqual([]);
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should say nothing at all under HAI_UPDATED=1, so a broken release cannot loop", async () => {
    // Arrange — the re-exec after an update, which must not check or install again.
    const seams = createFakeSeams({ env: { HOME, HAI_UPDATED: "1", HAI_VERBOSE: "1" }, fetch: feed(LATEST).fetch, respond: installs });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(seams.lines).toEqual([]);
  });

  it("should do nothing when we already have the latest", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, fetch: feed(CURRENT).fetch, respond: installs });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(outcome.reExec).toBe(false);
    expect(seams.runner.calls).toEqual([]);
    expect(seams.lines).toEqual([]);
  });

  it("should cache what the feed said for 6h", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, fetch: feed(CURRENT).fetch, respond: installs });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")).toEqual({ at: FIXED_NOW, latest: CURRENT });
  });

  it("should use a fresh cache rather than ask the feed again", async () => {
    // Arrange
    const { requests, fetch } = feed(LATEST);
    const cache = JSON.stringify({ at: FIXED_NOW - 1000, latest: CURRENT });
    const seams = createFakeSeams({ env: { HOME }, fetch, respond: installs, files: { [CACHE_PATH]: cache } });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(requests).toEqual([]);
  });

  it.each([
    ["a stale cache", JSON.stringify({ at: FIXED_NOW - CACHE_TTL_MS, latest: "0.0.1" })],
    ["an unparseable cache", "not json"],
    ["a cache with no timestamp", JSON.stringify({ latest: "0.0.1" })],
    ["a cache with no version", JSON.stringify({ at: FIXED_NOW })]
  ])("should ask the feed again given %s", async (_name, cache) => {
    // Arrange
    const { requests, fetch } = feed(CURRENT);
    const seams = createFakeSeams({ env: { HOME }, fetch, respond: installs, files: { [CACHE_PATH]: cache } });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(requests.map((request) => request.url)).toEqual([PACKUMENT_URL]);
  });

  it.each([
    ["the network is down", feed(null).fetch],
    ["the feed answers an error", feed(LATEST, 503).fetch],
    ["the feed names no published version", async () => new Response("{}")]
  ])("should stay silent when %s", async (_name, fetch) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, fetch, respond: installs });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(outcome.reExec).toBe(false);
    expect(seams.lines).toEqual([]);
    expect(seams.runner.calls).toEqual([]);
  });

  it("should explain a failed check under verbosity", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, fetch: feed(null).fetch });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(seams.lines.join("")).toContain(`could not check for a newer ${PACKAGE_NAME}`);
  });

  it.each([
    ["HAI_NO_UPDATE=1", { HAI_NO_UPDATE: "1" }, CURRENT, "HAI_NO_UPDATE=1, so the update check is skipped"],
    ["HAI_OFFLINE=1", { HAI_OFFLINE: "1" }, CURRENT, "HAI_OFFLINE=1, so the update check is skipped"],
    ["HAI_DRY_RUN=1", { HAI_DRY_RUN: "1" }, CURRENT, "HAI_DRY_RUN=1, so the update check is skipped"],
    ["an unpublished build", {}, "0.0.0", "running an unpublished 0.0.0 build, so the update check is skipped"]
  ])("should say under verbosity that %s turned the check off", async (_name, env, currentVersion, expected) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1", ...env }, fetch: feed(LATEST).fetch, respond: installs });

    // Act
    await maybeSelfUpdate({ seams, currentVersion });

    // Assert
    expect(seams.lines.join("")).toContain(expected);
  });

  it("should print the command rather than re-exec when the install fails", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, fetch: feed(LATEST).fetch, respond: () => ({ code: 1, stderr: "E404" }) });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    const said = seams.lines.join("");
    expect(outcome.reExec).toBe(false);
    expect(said).toContain(`could not update automatically; run: npm install -g ${PACKAGE_NAME} ${REGISTRY_ARG}`);
    expect(said).toContain("E404");
    expect(said).not.toContain("sudo");
  });

  it("should print the command rather than sudo when its own install prefix is not writable", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, fetch: feed(LATEST).fetch, respond: installs });
    seams.fs.unwritable.add(packageRoot());

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    const said = seams.lines.join("");
    expect(outcome.reExec).toBe(false);
    expect(seams.runner.calls).toEqual([]);
    expect(said).toContain(`Update with: npm install -g ${PACKAGE_NAME} ${REGISTRY_ARG}`);
    expect(said).toContain("install prefix is not writable");
    expect(said).not.toContain("sudo");
  });

  it("should never update under npx, and say nothing about it", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, npm_command: "exec" }, fetch: feed(LATEST).fetch, respond: installs });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(outcome.reExec).toBe(false);
    expect(seams.runner.calls).toEqual([]);
    expect(seams.lines).toEqual([]);
  });

  it("should explain under verbosity why it did not update under npx", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, npm_command: "exec", HAI_VERBOSE: "1" }, fetch: feed(LATEST).fetch, respond: installs });

    // Act
    await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(seams.lines.join("")).toContain("running under npx");
  });

  it("should carry on when the update cache cannot be written", async () => {
    // Arrange — no HOME, so there is no state directory to write into.
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, fetch: feed(CURRENT).fetch, respond: installs });

    // Act
    const outcome = await maybeSelfUpdate({ seams, currentVersion: CURRENT });

    // Assert
    expect(outcome.reExec).toBe(false);
    expect(seams.lines.join("")).toContain("could not write the update cache");
  });
});
