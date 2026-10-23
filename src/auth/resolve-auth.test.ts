import { describe, expect, it } from "vitest";
import { createFakeHiddenInput, createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "../az/group-membership.js";
import type { AgentHub } from "./agent-hub.js";
import { CACHE_FILE, CACHE_TTL_MS } from "./auth-cache.js";
import { HELPER_FILE } from "./gateway.js";
import { resolveAuth } from "./resolve-auth.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const ACCOUNT = JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } });
const IDENTITY = "tenant:dev@hmcts.net";
const CREDENTIALS = `${HOME}/.claude/.credentials.json`;
const LIVE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: Number.MAX_SAFE_INTEGER } });

const hub = (getCredential: AgentHub["getCredential"] = async () => null): AgentHub => ({
  baseUrl: "https://hub.test",
  getCredential,
  putCredential: async () => undefined
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

  it("should reuse a cached group answer rather than ask Graph again, and leave its timestamp alone", async () => {
    // Arrange — re-stamping a hit slid the TTL forward on every run, so Graph was asked
    // once and never again for anyone who runs hai at least daily.
    const cache = { [IDENTITY]: { group: { at: FIXED_NOW - 1000, isMember: true } } };
    const seams = createFakeSeams({ env: { HOME }, files: { [CACHE_PATH]: JSON.stringify(cache) }, respond: respondWithGateway });

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(resolution).toMatchObject({ route: "ai-gateway", credentialSource: "gateway-apim" });
    expect(askedGraph(seams.runner.calls)).toBe(false);
    expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")).toEqual(cache);
  });

  it("should ask Graph again once the cached answer has genuinely expired", async () => {
    // Arrange — one run to stamp the answer, then past the TTL with the same state dir.
    let now = FIXED_NOW;
    const seams = createFakeSeams({ env: { HOME }, respond: respondWithGateway, clock: { now: () => now, sleep: async () => undefined } });
    await resolveAuth({ seams, agentHub: hub() });
    now += CACHE_TTL_MS + 1;

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(resolution).toMatchObject({ route: "ai-gateway", credentialSource: "gateway-apim" });
    expect(seams.runner.calls.filter((call) => call.argv[1] === "rest")).toHaveLength(2);
    expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")).toEqual({ [IDENTITY]: { group: { at: now, isMember: true } } });
  });

  it("should cache nothing when az cannot say who we are", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => (argv[1] === "account" ? { code: 1, stderr: "no" } : respondAz(argv)) });

    // Act
    await resolveAuth({ seams, agentHub: hub(async () => KEY) });

    // Assert
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should ask az who we are when offline but never call Graph", async () => {
    // Arrange — `az account show` is a local read of ~/.azure, so it is the one az call
    // offline still makes: without it there is no cache key and no cached membership.
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1" }, respond: respondAz });

    // Act
    const { resolution } = await resolveAuth({ seams, agentHub: hub() });

    // Assert — unknown membership with nothing personal to reach for still offers the prompt.
    expect(resolution).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
    expect(seams.runner.calls.map((call) => call.argv)).toEqual([["az", "account", "show", "-o", "json"]]);
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
    await expect(act).rejects.toThrow(/DTSSE channel[\s\S]*HAI_ROUTE=ai-gateway[\s\S]*claude setup-token/);
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
      expect(auth.resolution.route).toBe("ai-gateway");
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
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "ai-gateway" }, respond: respondAz });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("could not read the AI Gateway APIM key");
    });
  });

  describe("decide-only", () => {
    it("should resolve a member's route without the Key Vault, the helper script or a word on the terminal", async () => {
      // Arrange — respondAz answers nothing for the Key Vault, which is the off-VPN shape.
      const seams = createFakeSeams({ env: { HOME }, respond: respondAz });

      // Act
      const auth = await resolveAuth({ seams, agentHub: hub(), decideOnly: true });

      // Assert
      expect(auth.resolution).toMatchObject({ route: "ai-gateway", credentialSource: "gateway-apim" });
      expect(auth.gateway).toBeUndefined();
      expect(seams.runner.calls.some((call) => call.argv[1] === "keyvault")).toBe(false);
      expect(seams.fs.store.has(`${HOME}/.local/state/hai/${HELPER_FILE}`)).toBe(false);
      expect(seams.lines).toEqual([]);
    });

    it("should report an explicit route without asking anything at all", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "byol" }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: respondAz });

      // Act
      const auth = await resolveAuth({ seams, agentHub: hub(), decideOnly: true });

      // Assert
      expect(auth.resolution).toMatchObject({ route: "byol", credentialSource: "host-oauth" });
      expect(seams.runner.calls).toEqual([]);
      expect(seams.lines).toEqual([]);
    });
  });

  describe("an explicit route, which is obeyed", () => {
    it.each<[string, string, string]>([
      ["agent-hub", "agent-hub", "agent-hub"],
      ["byol", "byol", "host-oauth"],
      ["bedrock", "bedrock", "prompt"]
    ])("should obey HAI_ROUTE=%s for a confirmed member, naming no fallback", async (requested, route, credentialSource) => {
      // Arrange — a member with a live personal login, which the default path refuses.
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: requested }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: respondAz });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution).toMatchObject({ route, credentialSource });
    });

    it("should read neither az nor the cache, which is the round trip a named route drops", async () => {
      // Arrange — a cached member, and a route that says not to care.
      const cache = { [IDENTITY]: { group: { at: FIXED_NOW - 1000, isMember: true } } };
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: "byol" }, files: { [CACHE_PATH]: JSON.stringify(cache) }, respond: respondAz });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution.route).toBe("byol");
      expect(seams.runner.calls).toEqual([]);
      expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")).toEqual(cache);
    });

    it.each([
      ["own-licence", "byol"],
      ["gateway", "ai-gateway"]
    ])("should fail on the old name %s rather than accept it", async (old, replacement) => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_ROUTE: old }, respond: respondAz });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow(`HAI_ROUTE=${replacement}`);
    });
  });

  describe("the block on a personal subscription", () => {
    it("should refuse a host claude.ai login when membership could not be confirmed", async () => {
      // Arrange — az answers for the identity but Graph refuses, which is the usual VPN-down shape.
      const graphRefused = (argv: string[]) => (argv[1] === "rest" ? { code: 1, stderr: "AADSTS700082" } : respondAz(argv));
      const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: graphRefused });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("HAI_ROUTE=byol");
    });

    it("should refuse offline by naming HAI_ROUTE=byol, not the az login HAI_OFFLINE opted out of", async () => {
      // Arrange — the identity resolves and the cache holds nothing for it, so offline
      // there is still no membership answer to be had and the refusal stands; what it must
      // not do is prescribe the lookups the flag asked it to skip.
      const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, respond: respondAz });

      // Act
      const err = await resolveAuth({ seams, agentHub: hub() }).catch((e: Error) => e);

      // Assert
      expect((err as Error).message).toContain("HAI_ROUTE=byol");
      expect((err as Error).message).not.toMatch(/az login|VPN/);
      expect(askedGraph(seams.runner.calls)).toBe(false);
    });

    it("should leave a confirmed non-member on their own licence", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME }, files: { [CREDENTIALS]: LIVE_LOGIN }, respond: notAMember });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution).toMatchObject({ route: "byol", credentialSource: "host-oauth" });
    });
  });

  describe("offline, where the cache is the whole membership answer", () => {
    const cacheFor = (isMember: boolean) => JSON.stringify({ [IDENTITY]: { group: { at: FIXED_NOW - 1000, isMember } } });

    it("should decide from the cached answer without asking Graph, and stamp nothing on the hit", async () => {
      // Arrange — the hole this closes: offline the key was never derived, so a confirmed
      // member read as unknown and an exported token decided the route.
      const cached = cacheFor(true);
      const env = { HOME, HAI_OFFLINE: "1", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" };
      const seams = createFakeSeams({ env, files: { [CACHE_PATH]: cached }, respond: respondWithGateway });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert — the member goes where HMCTS pays, and a hit has nothing to write.
      expect(resolution).toMatchObject({ route: "ai-gateway", credentialSource: "gateway-apim" });
      expect(askedGraph(seams.runner.calls)).toBe(false);
      expect(seams.fs.store.get(CACHE_PATH)).toBe(cached);
    });

    it("should refuse rather than spend an exported token when a cached member has no gateway to reach", async () => {
      // Arrange — respondAz answers no Key Vault, and nothing to paste a Bedrock key into.
      const seams = createFakeSeams({
        env: { HOME, HAI_OFFLINE: "1", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
        files: { [CACHE_PATH]: cacheFor(true) },
        respond: respondAz,
        hiddenInput: createFakeHiddenInput([], false)
      });

      // Act
      const act = resolveAuth({ seams, agentHub: hub() });

      // Assert
      await expect(act).rejects.toThrow("hai will not use a personal claude.ai subscription instead");
    });

    it("should obey HAI_ROUTE=byol for a cached member without reading the cache at all", async () => {
      // Arrange — a confirmed member who has typed the route by name. The block guards the
      // accident; offline or not, a named route is not one.
      const seams = createFakeSeams({
        env: { HOME, HAI_OFFLINE: "1", HAI_ROUTE: "byol" },
        files: { [CACHE_PATH]: cacheFor(true), [CREDENTIALS]: LIVE_LOGIN },
        respond: respondAz
      });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution).toMatchObject({ route: "byol", credentialSource: "host-oauth" });
      expect(seams.runner.calls).toEqual([]);
    });

    it("should leave a cached non-member on their own licence with no refusal", async () => {
      // Arrange — the other half of reading the cache offline: a confirmed non-member with
      // a claude.ai login on this machine was refused for a membership already answered.
      const seams = createFakeSeams({
        env: { HOME, HAI_OFFLINE: "1" },
        files: { [CACHE_PATH]: cacheFor(false), [CREDENTIALS]: LIVE_LOGIN },
        respond: respondAz
      });

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert
      expect(resolution).toMatchObject({ route: "byol", credentialSource: "host-oauth" });
      expect(askedGraph(seams.runner.calls)).toBe(false);
    });

    it("should look the cache up under the same key it writes online, or the online write is never found", async () => {
      // Arrange — deriving the key two ways is what made the old route cache dead, so one
      // online run writes it and the offline run that follows has to find it.
      const env: Record<string, string> = { HOME };
      const seams = createFakeSeams({ env, respond: respondWithGateway });
      await resolveAuth({ seams, agentHub: hub() });
      const written = seams.fs.store.get(CACHE_PATH) ?? "{}";
      env.HAI_OFFLINE = "1";

      // Act
      const { resolution } = await resolveAuth({ seams, agentHub: hub() });

      // Assert — one Graph call for two runs is only possible if both keys are the same.
      expect(Object.keys(JSON.parse(written) as Record<string, unknown>)).toEqual([IDENTITY]);
      expect(seams.runner.calls.filter((call) => call.argv[1] === "rest")).toHaveLength(1);
      expect(resolution).toMatchObject({ route: "ai-gateway", credentialSource: "gateway-apim" });
    });
  });
});
