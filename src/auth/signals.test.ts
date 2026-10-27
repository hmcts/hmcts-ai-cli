import { describe, expect, it } from "vitest";
import { createFakeSeams, type RunResponder } from "../__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "../az/group-membership.js";
import type { AgentHub } from "./agent-hub.js";
import type { Route } from "./route.js";
import { gatherSignals, needsMembership, needsProbes, requestedRoute } from "./signals.js";

const HOME = "/home/dev";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const CREDENTIALS = `${HOME}/.claude/.credentials.json`;
const LIVE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: Number.MAX_SAFE_INTEGER } });

function fakeHub(stored: (kind: string) => Promise<string | null> = async () => null): AgentHub & { gets: string[] } {
  const hub = {
    gets: [] as string[],
    baseUrl: "https://hub.test",
    getCredential: async (kind: string) => {
      hub.gets.push(kind);
      return stored(kind);
    },
    putCredential: async () => undefined
  };
  return hub;
}

const memberResponse = () => ({ stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) });
const nonMemberResponse = () => ({ stdout: JSON.stringify({ value: [] }) });
const graphRefused = () => ({ code: 1, stderr: "AADSTS700082: the refresh token has expired" });

const askedGraph = (calls: { argv: string[] }[]) => calls.some((call) => call.argv[1] === "rest");

describe("requestedRoute", () => {
  it.each([["agent-hub"], ["byol"], ["ai-gateway"], ["bedrock"]])("should accept HAI_ROUTE=%s", (route) => {
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
    expect(() => requestedRoute({ HAI_ROUTE: "own_licence" })).toThrow("agent-hub, byol, ai-gateway, bedrock");
  });

  it.each([
    ["own-licence", "byol"],
    ["gateway", "ai-gateway"]
  ])("should refuse the old %s by name rather than accept or ignore it", (old, replacement) => {
    // Act / Assert — `gateway` is the one that bites: in cft-workspace
    // AGENT_HUB_MODEL_ROUTE=gateway means Bedrock, so an alias would keep two opposite
    // meanings of the word alive in files read together.
    expect(() => requestedRoute({ HAI_ROUTE: old })).toThrow(`HAI_ROUTE=${replacement}`);
  });
});

describe("needsProbes", () => {
  it.each<[string, Record<string, string>, Route | null, boolean]>([
    ["HAI_ROUTE=ai-gateway settles it", {}, "ai-gateway", false],
    ["HAI_ROUTE=byol settles it", {}, "byol", false],
    ["HAI_ROUTE=agent-hub settles it", {}, "agent-hub", false],
    ["HAI_ROUTE=bedrock settles it, the hub no longer being one of its sources", {}, "bedrock", false],
    ["a key in the environment settles it", { AWS_BEARER_TOKEN_BEDROCK: KEY }, null, false],
    ["an exported OAuth token no longer settles anything", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, null, true],
    ["nothing settles it", {}, null, true]
  ])("should report that %s", (_name, env, requested, expected) => {
    // Act / Assert
    expect(needsProbes(env, requested)).toBe(expected);
  });
});

describe("needsMembership", () => {
  it.each<[string, Record<string, string>, Route | null, boolean]>([
    ["an exported OAuth token, which no longer settles the route", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, null, true],
    ["no signal at all", {}, null, true],
    ["HAI_ROUTE=byol, which is obeyed rather than refused", {}, "byol", false],
    ["HAI_ROUTE=agent-hub, where membership changes nothing", {}, "agent-hub", false],
    ["HAI_ROUTE=ai-gateway, where membership changes nothing", {}, "ai-gateway", false],
    ["HAI_ROUTE=bedrock, where membership changes nothing", {}, "bedrock", false],
    ["a key in the environment, which membership is now decided ahead of", { AWS_BEARER_TOKEN_BEDROCK: KEY }, null, true]
  ])("should want the group answer for %s", (_name, env, requested, expected) => {
    // Act / Assert
    expect(needsMembership(env, requested)).toBe(expected);
  });
});

describe("gatherSignals", () => {
  it.each([["agent-hub"], ["byol"], ["ai-gateway"], ["bedrock"]])("should look nothing up at all for HAI_ROUTE=%s", async (route) => {
    // Arrange — an explicit route names one credential and one source, so no signal a
    // probe could find would change the answer: no agent-hub call and no az.
    const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: route }, respond: memberResponse });
    const agentHub = fakeHub(async () => KEY);

    // Act
    const { signals } = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals.requestedRoute).toBe(route);
    expect(agentHub.gets).toEqual([]);
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should still check the group behind a Bedrock key in the environment, which no longer settles the route", async () => {
    // Arrange — the key would have stopped this outright while Bedrock came first.
    const seams = createFakeSeams({ env: { AWS_BEARER_TOKEN_BEDROCK: KEY }, respond: memberResponse });
    const agentHub = fakeHub(async () => KEY);

    // Act
    const { signals } = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ hasBedrockEnvKey: true, isBedrockGroupMember: true });
    expect(askedGraph(seams.runner.calls)).toBe(true);
    // A confirmed member is on the gateway, so the hub has nothing left to answer.
    expect(agentHub.gets).toEqual([]);
  });

  it("should keep looking past an OAuth token in the environment, which no longer settles the route", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, respond: memberResponse });
    const agentHub = fakeHub();

    // Act
    const { signals } = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ hasOauthEnvToken: true, isBedrockGroupMember: true });
    // Nothing is asked after a confirmed membership: the gateway is already the answer.
    expect(agentHub.gets).toEqual([]);
  });

  it("should stop once the hub reports a stored key, membership having already come back no", async () => {
    // Arrange — a non-member, because for a member the hub is never reached at all.
    const seams = createFakeSeams({ env: { HOME }, respond: nonMemberResponse });
    const agentHub = fakeHub(async () => KEY);

    // Act
    const { signals } = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ hasStoredBedrockKey: true, hasHostClaudeCredential: false, isBedrockGroupMember: false });
    expect(agentHub.gets).toEqual(["bedrock"]);
  });

  it("should check the group before it looks for a host claude.ai login", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: nonMemberResponse });

    // Act
    const { signals } = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ isBedrockGroupMember: false, hasHostClaudeCredential: true });
  });

  it("should not look for a host claude.ai login at all once membership is confirmed", async () => {
    // Arrange — the login is live and on disk, and a member is routed to the gateway anyway.
    const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: memberResponse });

    // Act
    const { signals } = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ isBedrockGroupMember: true, hasHostClaudeCredential: false });
  });

  it("should still look for a host claude.ai login when Graph could not answer", async () => {
    // Arrange — the refusal that follows needs to know there is something to refuse.
    const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: graphRefused });

    // Act
    const { signals } = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: null });

    // Assert
    expect(signals).toMatchObject({ isBedrockGroupMember: null, hasHostClaudeCredential: true });
  });

  it("should not check the group when a cached answer is already in hand", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    const { signals } = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership: false });

    // Assert
    expect(signals.isBedrockGroupMember).toBe(false);
    expect(askedGraph(seams.runner.calls)).toBe(false);
  });

  it.each<[string, Record<string, string>, boolean | null, RunResponder, boolean]>([
    ["a call it made itself", {}, null, memberResponse, true],
    ["a call Graph refused, which is still a call", {}, null, graphRefused, true],
    ["a cached answer, which the caller must not restamp", {}, true, memberResponse, false],
    ["HAI_ROUTE=ai-gateway, where the group is never asked", { HAI_ROUTE: "ai-gateway" }, null, memberResponse, false]
  ])("should report the group answer as coming from %s", async (_name, env, cachedGroupMembership, respond, expected) => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, ...env }, respond });

    // Act
    const { askedGraph } = await gatherSignals({ seams, agentHub: fakeHub(), offline: false, cachedGroupMembership });

    // Assert
    expect(askedGraph).toBe(expected);
  });

  it("should treat a hub it cannot reach as no evidence either way", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, respond: nonMemberResponse });
    const agentHub = fakeHub(async () => {
      throw new Error("fetch failed");
    });

    // Act
    const { signals } = await gatherSignals({ seams, agentHub, offline: false, cachedGroupMembership: null });

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
      const { signals } = await gatherSignals({ seams, agentHub, offline: true, cachedGroupMembership: null });

      // Assert
      expect(agentHub.gets).toEqual([]);
      expect(seams.runner.calls).toHaveLength(0);
      expect(signals).toMatchObject({ hasStoredBedrockKey: false, isBedrockGroupMember: null });
      expect(seams.lines.join("")).toContain("HAI_OFFLINE=1");
    });

    it("should still read a claude.ai login off this machine, which is a file and not a lookup", async () => {
      // Arrange — a cached non-member needs this read to reach their own licence offline
      // rather than the three remedies.
      const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN } });

      // Act
      const { signals } = await gatherSignals({ seams, agentHub: fakeHub(), offline: true, cachedGroupMembership: false });

      // Assert
      expect(signals.hasHostClaudeCredential).toBe(true);
    });

    it("should still use a cached group answer", async () => {
      // Act
      const { signals } = await gatherSignals({ seams: createFakeSeams({ env: { HOME } }), agentHub: fakeHub(), offline: true, cachedGroupMembership: true });

      // Assert
      expect(signals.isBedrockGroupMember).toBe(true);
    });
  });
});
