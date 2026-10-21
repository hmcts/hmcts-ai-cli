import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "../az/group-membership.js";
import type { AgentHub } from "./agent-hub.js";
import { CACHE_FILE } from "./auth-cache.js";
import { resolveAuth } from "./resolve-auth.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const ACCOUNT = JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } });
const IDENTITY = "tenant:dev@hmcts.net";

const hub = (getBedrockKey: AgentHub["getBedrockKey"] = async () => null): AgentHub => ({
  baseUrl: "https://hub.test",
  getBedrockKey,
  putBedrockKey: async () => undefined
});

function respondAz(argv: string[]) {
  if (argv[1] === "account" && argv[2] === "show") {
    return { stdout: ACCOUNT };
  }
  if (argv[1] === "rest") {
    return { stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) };
  }
  return undefined;
}

describe("resolveAuth", () => {
  it("should resolve a route and cache it under the signed-in identity", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: respondAz });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub(async () => KEY) });

    // Assert
    expect(result).toMatchObject({ route: "bedrock", credentialSource: "agent-hub" });
    const cached = JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}");
    expect(cached[IDENTITY].route).toMatchObject({ at: FIXED_NOW, route: "bedrock", credentialSource: "agent-hub" });
  });

  it("should cache the group answer when one was obtained", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: respondAz });

    // Act
    await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")[IDENTITY].group).toEqual({ at: FIXED_NOW, isMember: true });
  });

  it("should cache under an anonymous key when az cannot say who we are", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => (argv[1] === "account" ? { code: 1, stderr: "no" } : respondAz(argv)) });

    // Act
    await resolveAuth({ seams, agentHub: hub(async () => KEY) });

    // Assert
    expect(Object.keys(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}"))).toEqual(["anonymous"]);
  });

  it("should not ask az who we are when offline", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY, HAI_OFFLINE: "1" } });

    // Act
    await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(seams.runner.calls).toHaveLength(0);
  });

  it("should reuse the cached route when offline", async () => {
    // Arrange
    const cache = { anonymous: { route: { at: FIXED_NOW - 1000, route: "bedrock", credentialSource: "agent-hub", reasons: ["agent-hub holds a key"] } } };
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1", HAI_VERBOSE: "1" }, files: { [CACHE_PATH]: JSON.stringify(cache) } });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(result).toMatchObject({ route: "bedrock", credentialSource: "agent-hub" });
    expect(result.reasons).toContain("from the 12h route cache");
    expect(seams.lines.join("")).toContain("using the cached bedrock route");
  });

  it.each([
    ["a Bedrock key in the environment", { AWS_BEARER_TOKEN_BEDROCK: KEY }, "bedrock", "env"],
    ["an OAuth token in the environment", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, "own-licence", "env"]
  ])("should prefer %s over the cached route when offline", async (_name, env, route, credentialSource) => {
    // Arrange
    const cache = { anonymous: { route: { at: FIXED_NOW - 1000, route: "gateway", credentialSource: "gateway-apim", reasons: [] } } };
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1", ...env }, files: { [CACHE_PATH]: JSON.stringify(cache) } });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(result).toMatchObject({ route, credentialSource });
  });

  it("should prefer HAI_ROUTE over the cached route when offline", async () => {
    // Arrange
    const cache = { anonymous: { route: { at: FIXED_NOW - 1000, route: "bedrock", credentialSource: "agent-hub", reasons: [] } } };
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1", HAI_ROUTE: "gateway" }, files: { [CACHE_PATH]: JSON.stringify(cache) } });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(result.route).toBe("gateway");
  });

  it("should resolve afresh when offline with nothing cached", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1" } });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert — unknown membership still offers the prompt rather than failing outright.
    expect(result).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
  });

  it("should fail with all three remedies when no signal fires at all", async () => {
    // Arrange
    const notAMember = (argv: string[]) => (argv[1] === "rest" ? { stdout: JSON.stringify({ value: [] }) } : respondAz(argv));
    const seams = createFakeSeams({ env: { HOME }, respond: notAMember });

    // Act
    const act = resolveAuth({ seams, agentHub: hub() });

    // Assert
    await expect(act).rejects.toThrow(/DTSSE channel[\s\S]*HAI_ROUTE=gateway[\s\S]*claude setup-token/);
  });

  it("should not cache a failure", async () => {
    // Arrange
    const notAMember = (argv: string[]) => (argv[1] === "rest" ? { stdout: JSON.stringify({ value: [] }) } : respondAz(argv));
    const seams = createFakeSeams({ env: { HOME }, respond: notAMember });

    // Act
    await resolveAuth({ seams, agentHub: hub() }).catch(() => undefined);

    // Assert
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should carry on when the cache cannot be written", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, respond: respondAz });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub(async () => KEY) });

    // Assert — no HOME means no state dir, which must not stop a launch.
    expect(result.route).toBe("bedrock");
    expect(seams.lines.join("")).toContain("could not write the route cache");
  });

  it("should ask az who we are before it asks agent-hub anything", async () => {
    // Arrange
    const order: string[] = [];
    const seams = createFakeSeams({
      env: { HOME },
      respond: (argv) => {
        order.push(`az ${argv[1]}`);
        return respondAz(argv);
      }
    });
    const agentHub = hub(async () => {
      order.push("hub get");
      return KEY;
    });

    // Act
    await resolveAuth({ seams, agentHub });

    // Assert
    expect(order).toEqual(["az account", "hub get"]);
  });
});
