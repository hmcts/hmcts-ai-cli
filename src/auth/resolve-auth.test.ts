import { describe, expect, it } from "vitest";
import { createFakeHiddenInput, createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "../az/group-membership.js";
import type { AgentHub } from "./agent-hub.js";
import { CACHE_FILE } from "./auth-cache.js";
import { resolveAuth } from "./resolve-auth.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const ACCOUNT = JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } });
const IDENTITY = "tenant:dev@hmcts.net";
const CREDENTIALS = `${HOME}/.claude/.credentials.json`;
const LIVE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: Number.MAX_SAFE_INTEGER } });

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

/** A member whose Key Vault and VPN both answer, so the gateway is genuinely usable. */
function respondWithGateway(argv: string[]) {
  if (argv[0] === "getent") {
    return { code: 0 };
  }
  if (argv[1] === "keyvault") {
    return { stdout: `${APIM_KEY}\n` };
  }
  return respondAz(argv);
}

const notAMember = (argv: string[]) => (argv[1] === "rest" ? { stdout: JSON.stringify({ value: [] }) } : respondAz(argv));
const askedGraph = (calls: { argv: string[] }[]) => calls.some((call) => call.argv[1] === "rest");

describe("resolveAuth", () => {
  it("should cache the group answer under the signed-in identity", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: respondWithGateway });

    // Act
    await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")).toEqual({ [IDENTITY]: { group: { at: FIXED_NOW, isMember: true } } });
  });

  it("should reuse a cached group answer rather than ask Graph again", async () => {
    // Arrange
    const cache = { [IDENTITY]: { group: { at: FIXED_NOW - 1000, isMember: true } } };
    const seams = createFakeSeams({ env: { HOME }, files: { [CACHE_PATH]: JSON.stringify(cache) }, respond: respondWithGateway });

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(resolution).toMatchObject({ route: "gateway", credentialSource: "gateway-apim" });
    expect(askedGraph(seams.runner.calls)).toBe(false);
  });

  it("should cache nothing when az cannot say who we are", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => (argv[1] === "account" ? { code: 1, stderr: "no" } : respondAz(argv)) });

    // Act
    await resolveAuth({ seams, agentHub: hub(async () => KEY) });

    // Assert
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should ask az nothing at all when offline", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1" } });

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert — unknown membership with nothing personal to reach for still offers the prompt.
    expect(resolution).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
    expect(seams.runner.calls).toHaveLength(0);
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should ask az nothing when the environment already settles the route", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY } });

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(resolution).toMatchObject({ route: "bedrock", credentialSource: "env" });
    expect(seams.runner.calls).toHaveLength(0);
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should fail with all three remedies when no signal fires at all", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: notAMember });

    // Act
    const act = resolveAuth({ seams, agentHub: hub() });

    // Assert
    await expect(act).rejects.toThrow(/DTSSE channel[\s\S]*HAI_ROUTE=gateway[\s\S]*claude setup-token/);
  });

  it("should not cache a failure", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: notAMember });

    // Act
    await resolveAuth({ seams, agentHub: hub() }).catch(() => undefined);

    // Assert
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should carry on when the cache cannot be written", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, respond: respondWithGateway });

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert — no HOME means no state dir, which must not stop a launch; it also leaves
    // nowhere to write the gateway's apiKeyHelper, so this lands on the Bedrock fallback.
    expect(resolution).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
    expect(seams.lines.join("")).toContain("could not write the group-membership cache");
  });

  it("should ask az who we are before it asks agent-hub anything", async () => {
    // Arrange
    const order: string[] = [];
    const seams = createFakeSeams({
      env: { HOME },
      respond: (argv) => {
        order.push(`az ${argv[1]}`);
        return respondWithGateway(argv);
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

  describe("the gateway a group member is put on", () => {
    it("should prepare its APIM key and hand it back", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME }, respond: respondWithGateway });

      // Act
      const auth = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(auth.resolution.route).toBe("gateway");
      expect(auth.gateway?.apimKey).toBe(APIM_KEY);
    });

    it("should fall back to pasting a Bedrock key when the Key Vault cannot be read", async () => {
      // Arrange — the incident exactly: a member, a live personal login, and no Bedrock key.
      const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: respondAz });

      // Act
      const auth = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(auth.resolution).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
      expect(auth.gateway).toBeUndefined();
    });

    it("should say which fallback it took and why, because silence here is what caused the incident", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME }, respond: respondAz });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      const said = seams.lines.join("");
      expect(said).toContain("the AI Gateway was chosen but its APIM key could not be read");
      expect(said).toContain("hai will not use your personal claude.ai subscription");
      expect(resolution.reasons.join(" ")).toContain("APIM key could not be read");
    });

    it("should fail rather than reach for a personal subscription when there is no terminal to paste into", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME },
        files: { [CREDENTIALS]: LIVE_LOGIN },
        respond: respondAz,
        hiddenInput: createFakeHiddenInput([], false)
      });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("hai will not use a personal claude.ai subscription instead");
    });

    it("should fail outright rather than downgrade a gateway asked for by name", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "gateway" }, respond: respondAz });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("could not read the AI Gateway APIM key");
    });
  });

  describe("the block on a personal subscription", () => {
    it("should refuse HAI_ROUTE=own-licence for a confirmed member", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "own-licence" }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: respondAz });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("HMCTS funds your Claude usage");
    });

    it("should refuse a host claude.ai login when membership could not be confirmed", async () => {
      // Arrange — az answers for the identity but Graph refuses, which is the usual VPN-down shape.
      const graphRefused = (argv: string[]) => (argv[1] === "rest" ? { code: 1, stderr: "AADSTS700082" } : respondAz(argv));
      const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: graphRefused });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("HAI_ROUTE=own-licence");
    });

    it("should allow HAI_ROUTE=own-licence when membership could not be confirmed, which is a deliberate choice", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "own-licence" }, files: { [CREDENTIALS]: LIVE_LOGIN } });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution).toMatchObject({ route: "own-licence", credentialSource: "host-oauth" });
    });

    it("should leave a confirmed non-member on their own licence", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: notAMember });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution).toMatchObject({ route: "own-licence", credentialSource: "host-oauth" });
    });
  });
});
