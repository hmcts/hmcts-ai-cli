import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { credentialsPath, hasHostClaudeCredential, hasLiveClaudeAiLogin, KEYCHAIN_SERVICE, PROXY_MANAGED_SENTINEL } from "./claude-credentials.js";

const HOME = "/home/dev";
const CREDENTIALS = `${HOME}/.claude/.credentials.json`;
const LIVE = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-ZmFrZS1jbGF1ZGUtb2F1dGg", expiresAt: FIXED_NOW + 60_000 } });

describe("credentialsPath", () => {
  it("should sit under the home directory", () => {
    // Act / Assert
    expect(credentialsPath({ HOME })).toBe(CREDENTIALS);
  });

  it.each([
    ["no HOME", {}],
    ["an empty HOME", { HOME: "" }]
  ])("should give up with %s", (_name, env) => {
    // Act / Assert
    expect(credentialsPath(env)).toBeNull();
  });
});

describe("hasLiveClaudeAiLogin", () => {
  it("should accept a live token", () => {
    // Act / Assert
    expect(hasLiveClaudeAiLogin(LIVE, FIXED_NOW)).toBe(true);
  });

  it("should reject the proxy-managed sentinel, which is not a real login", () => {
    // Arrange
    const sentinel = JSON.stringify({ claudeAiOauth: { accessToken: PROXY_MANAGED_SENTINEL, expiresAt: FIXED_NOW + 60_000 } });

    // Act / Assert
    expect(hasLiveClaudeAiLogin(sentinel, FIXED_NOW)).toBe(false);
  });

  it.each([
    ["an expired token", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: FIXED_NOW - 1 } })],
    ["a token expiring exactly now", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: FIXED_NOW } })],
    ["no expiry", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x" } })],
    ["an unparseable expiry", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: "soon" } })],
    ["no accessToken", JSON.stringify({ claudeAiOauth: { expiresAt: FIXED_NOW + 60_000 } })],
    ["an empty accessToken", JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: FIXED_NOW + 60_000 } })],
    ["a non-string accessToken", JSON.stringify({ claudeAiOauth: { accessToken: 7, expiresAt: FIXED_NOW + 60_000 } })],
    ["no claudeAiOauth block", JSON.stringify({ other: true })],
    ["unparseable json", "not json"]
  ])("should reject %s", (_name, contents) => {
    // Act / Assert
    expect(hasLiveClaudeAiLogin(contents, FIXED_NOW)).toBe(false);
  });
});

describe("hasHostClaudeCredential", () => {
  it("should read the credentials file when it is there", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE } });

    // Act / Assert
    expect(await hasHostClaudeCredential(seams)).toBe(true);
  });

  it("should report nothing on linux when the file is absent", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    const result = await hasHostClaudeCredential(seams);

    // Assert
    expect(result).toBe(false);
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should report nothing when there is no home directory to look in", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {} });

    // Act / Assert
    expect(await hasHostClaudeCredential(seams)).toBe(false);
  });

  it("should fall back to the macOS login keychain", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, platform: "darwin", respond: () => ({ stdout: LIVE }) });

    // Act
    const result = await hasHostClaudeCredential(seams);

    // Assert
    expect(result).toBe(true);
    expect(seams.runner.calls[0]?.argv).toEqual(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  });

  it("should not consult the keychain when the file already answered", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, platform: "darwin", files: { [CREDENTIALS]: LIVE } });

    // Act
    await hasHostClaudeCredential(seams);

    // Assert
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should point at claude setup-token when neither the file nor the keychain has anything", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, platform: "darwin", respond: () => ({ code: 44, stderr: "not found" }) });

    // Act
    const result = await hasHostClaudeCredential(seams);

    // Assert
    expect(result).toBe(false);
    expect(seams.lines.join("")).toContain("claude setup-token");
    expect(seams.lines.join("")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
