import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "../az/group-membership.js";
import type { AgentHub } from "./agent-hub.js";
import { gatherSignals, requestedRoute } from "./signals.js";

const HOME = "/home/dev";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";

function fakeHub(getBedrockKey: AgentHub["getBedrockKey"] = async () => null): AgentHub & { gets: number } {
  const hub = {
    gets: 0,
    baseUrl: "https://hub.test",
    getBedrockKey: async () => {
      hub.gets += 1;
      return getBedrockKey();
    },
    putBedrockKey: async () => undefined
  };
  return hub;
}

const memberResponse = () => ({ stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) });

describe("requestedRoute", () => {
  it.each([["bedrock"], ["gateway"], ["own-licence"]])("should accept HAI_ROUTE=%s", (route) => {
    // Act / Assert
    expect(requestedRoute({ HAI_ROUTE: route })).toBe(route);
  });

  it.each([
    ["an unset HAI_ROUTE", {}],
    ["an empty HAI_ROUTE", { HAI_ROUTE: "" }]
  ])("should read %s as no request", (_name, env) => {
    // Act / Assert
    expect(requestedRoute(env)).toBeNull();
  });

  it("should refuse an unknown route and list the real ones", () => {
    // Act / Assert
    expect(() => requestedRoute({ HAI_ROUTE: "own_licence" })).toThrow("bedrock, gateway, own-licence");
  });
});

describe("gatherSignals", () => {
  it("should skip every probe for HAI_ROUTE=gateway", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_ROUTE: "gateway" } });
    const agentHub = fakeHub();

    // Act
    const signals = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals.requestedRoute).toBe("gateway");
    expect(agentHub.gets).toBe(0);
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should skip every probe for HAI_ROUTE=own-licence", async () => {
    // Arrange
    const agentHub = fakeHub();

    // Act
    await gatherSignals({ seams: createFakeSeams({ env: { HAI_ROUTE: "own-licence" } }), agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(agentHub.gets).toBe(0);
  });

  it("should stop at a Bedrock key in the environment", async () => {
    // Arrange
    const agentHub = fakeHub(async () => KEY);

    // Act
    const signals = await gatherSignals({
      seams: createFakeSeams({ env: { AWS_BEARER_TOKEN_BEDROCK: KEY } }),
      agentHub,
      offline: false,
      cachedGroupMembership: null
    });

    // Assert
    expect(signals.hasBedrockEnvKey).toBe(true);
    expect(agentHub.gets).toBe(0);
  });

  it("should stop at an OAuth token in the environment", async () => {
    // Arrange
    const agentHub = fakeHub();

    // Act
    const signals = await gatherSignals({
      seams: createFakeSeams({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } }),
      agentHub,
      offline: false,
      cachedGroupMembership: null
    });

    // Assert
    expect(signals.hasOauthEnvToken).toBe(true);
    expect(agentHub.gets).toBe(0);
  });

  it("should still ask the hub for HAI_ROUTE=bedrock even with an OAuth token present", async () => {
    // Arrange
    const agentHub = fakeHub(async () => KEY);
    const seams = createFakeSeams({ env: { HAI_ROUTE: "bedrock", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } });

    // Act
    const signals = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(agentHub.gets).toBe(1);
    expect(signals.hasStoredBedrockKey).toBe(true);
  });

  it("should stop once the hub reports a stored key", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });
    const agentHub = fakeHub(async () => KEY);

    // Act
    const signals = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ hasStoredBedrockKey: true, hasHostClaudeCredential: false, isBedrockGroupMember: null });
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should fall through to the host credential and then the group check", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: memberResponse });

    // Act
    const signals = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ hasHostClaudeCredential: false, isBedrockGroupMember: true });
  });

  it("should stop at a live host claude.ai login without checking the group", async () => {
    // Arrange
    const live = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: Number.MAX_SAFE_INTEGER } });
    const seams = createFakeSeams({ env: { HOME }, files: { [`${HOME}/.claude/.credentials.json`]: live }, respond: memberResponse });

    // Act
    const signals = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ hasHostClaudeCredential: true, isBedrockGroupMember: null });
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should not check the group when a cached answer is already in hand", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    const signals = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: false });

    // Assert
    expect(signals.isBedrockGroupMember).toBe(false);
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should not look for a host claude.ai login when bedrock was asked for by name", async () => {
    // Arrange
    const live = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: Number.MAX_SAFE_INTEGER } });
    const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "bedrock" }, files: { [`${HOME}/.claude/.credentials.json`]: live }, respond: memberResponse });

    // Act
    const signals = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals.hasHostClaudeCredential).toBe(false);
  });

  it("should treat a hub it cannot reach as no evidence either way", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, respond: memberResponse });
    const agentHub = fakeHub(async () => {
      throw new Error("fetch failed");
    });

    // Act
    const signals = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals.hasStoredBedrockKey).toBe(false);
    expect(seams.lines.join("")).toContain("could not ask agent-hub");
  });

  describe("offline", () => {
    it("should consult neither agent-hub nor Graph", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" } });
      const agentHub = fakeHub(async () => KEY);

      // Act
      const signals = await gatherSignals({ seams, agentHub, offline: true, cachedGroupMembership: null });

      // Assert
      expect(agentHub.gets).toBe(0);
      expect(seams.runner.calls).toHaveLength(0);
      expect(signals).toMatchObject({ hasStoredBedrockKey: false, isBedrockGroupMember: null });
      expect(seams.lines.join("")).toContain("HAI_OFFLINE=1");
    });

    it("should still use a cached group answer", async () => {
      // Act
      const signals = await gatherSignals({ seams: createFakeSeams({ env: { HOME } }), agentHub: fakeHub(), offline: true, cachedGroupMembership: true });

      // Assert
      expect(signals.isBedrockGroupMember).toBe(true);
    });
  });
});
