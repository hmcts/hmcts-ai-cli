import { describe, expect, it } from "vitest";
import { buildClaudeEnv, conflictingEnv, DEFAULT_AWS_REGION, DEFAULT_MODELS, GATEWAY_BEDROCK_BASE_URL } from "./claude-env.js";
import { ROUTES, type Route } from "./route.js";

const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const CLAUDE_TOKEN = "sk-ant-oat01-from-the-hub";
const GATEWAY = { apimKey: APIM_KEY, helperPath: "/home/dev/.local/state/hai/gateway-token.sh" };

describe("buildClaudeEnv", () => {
  describe("bedrock", () => {
    it("should set exactly what run.sh sets", () => {
      // Act
      const added = buildClaudeEnv({ env: {}, route: "bedrock", bedrockKey: BEDROCK_KEY });

      // Assert
      expect(added).toEqual({
        AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY,
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: DEFAULT_AWS_REGION,
        ...DEFAULT_MODELS
      });
    });

    it.each([
      ["AWS_REGION", "eu-west-1"],
      ...Object.keys(DEFAULT_MODELS).map((name) => [name, "eu.anthropic.something-else"] as [string, string])
    ])("should let an existing %s win, the way run.sh defaults only when unset", (name, value) => {
      // Act
      const added = buildClaudeEnv({ env: { [name]: value }, route: "bedrock", bedrockKey: BEDROCK_KEY });

      // Assert
      expect(added[name]).toBe(value);
    });

    it("should treat an empty existing value as unset", () => {
      // Act
      const added = buildClaudeEnv({ env: { AWS_REGION: "" }, route: "bedrock", bedrockKey: BEDROCK_KEY });

      // Assert
      expect(added.AWS_REGION).toBe(DEFAULT_AWS_REGION);
    });

    it("should refuse to build a bedrock environment with no key", () => {
      // Act / Assert
      expect(() => buildClaudeEnv({ env: {}, route: "bedrock" })).toThrow("needs a Bedrock API key");
    });
  });

  describe("ai-gateway", () => {
    it("should set the gateway variables, carrying the APIM key in a custom header", () => {
      // Act
      const added = buildClaudeEnv({ env: {}, route: "ai-gateway", gateway: GATEWAY });

      // Assert
      expect(added).toEqual({
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "300000",
        AWS_REGION: DEFAULT_AWS_REGION,
        ANTHROPIC_BEDROCK_BASE_URL: GATEWAY_BEDROCK_BASE_URL,
        ANTHROPIC_CUSTOM_HEADERS: `Ocp-Apim-Subscription-Key: ${APIM_KEY}`,
        ...DEFAULT_MODELS
      });
    });

    it("should never set a Bedrock bearer token, because the gateway authenticates for us", () => {
      // Act
      const added = buildClaudeEnv({ env: {}, route: "ai-gateway", gateway: GATEWAY });

      // Assert
      expect(added.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    });

    it("should let an existing base url win", () => {
      // Act
      const added = buildClaudeEnv({ env: { ANTHROPIC_BEDROCK_BASE_URL: "https://local/bedrock" }, route: "ai-gateway", gateway: GATEWAY });

      // Assert
      expect(added.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://local/bedrock");
    });

    it("should refuse to build a gateway environment with no APIM key", () => {
      // Act / Assert
      expect(() => buildClaudeEnv({ env: {}, route: "ai-gateway" })).toThrow("needs an APIM subscription key");
    });
  });

  describe("byol", () => {
    it("should set no Bedrock variables, which would override the OAuth credential", () => {
      // Act — handed every other credential there is, to prove none of them is injected.
      const added = buildClaudeEnv({ env: {}, route: "byol", bedrockKey: BEDROCK_KEY, claudeToken: CLAUDE_TOKEN, gateway: GATEWAY });

      // Assert
      expect(added).toEqual({});
    });

    it("should carry over an exported CLAUDE_CODE_OAUTH_TOKEN, which a container gets no other way", () => {
      // Act — container mode hands claude only what this returns, so `{}` left a byol
      // session on the bind-mounted ~/.claude login instead of the exported token.
      const added = buildClaudeEnv({ env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN }, route: "byol" });

      // Assert
      expect(added).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
    });

    it("should treat an empty exported token as unset, leaving the login on this machine to answer", () => {
      // Act
      const added = buildClaudeEnv({ env: { CLAUDE_CODE_OAUTH_TOKEN: "" }, route: "byol" });

      // Assert
      expect(added).toEqual({});
    });
  });

  describe("agent-hub", () => {
    it("should set the hub's Claude token and nothing else", () => {
      // Act — the Bedrock variables would override it, which is why byol adds none either.
      const added = buildClaudeEnv({ env: {}, route: "agent-hub", bedrockKey: BEDROCK_KEY, claudeToken: CLAUDE_TOKEN, gateway: GATEWAY });

      // Assert
      expect(added).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
    });

    it("should refuse to build an agent-hub environment with no token", () => {
      // Act / Assert — one credential from one source: no silent fall back to the login on
      // this machine, which is a different licence and a different bill.
      expect(() => buildClaudeEnv({ env: {}, route: "agent-hub" })).toThrow("needs the Claude token agent-hub holds for you");
    });
  });

  describe("conflictingEnv", () => {
    it.each<[Route, string[]]>([
      ["byol", ["AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "ANTHROPIC_CUSTOM_HEADERS"]],
      ["agent-hub", ["AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "ANTHROPIC_CUSTOM_HEADERS"]],
      ["ai-gateway", ["CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]],
      ["bedrock", ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "ANTHROPIC_CUSTOM_HEADERS"]]
    ])("should remove the other payers' variables on %s", (route, expected) => {
      // Act
      const removed = conflictingEnv(route);

      // Assert
      expect([...removed]).toEqual(expect.arrayContaining(expected));
    });

    it.each(ROUTES)("should remove ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN on %s, which no route of ours uses", (route) => {
      // Assert — either would quietly take precedence over the credential that pays.
      expect([...conflictingEnv(route)]).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]));
    });

    it.each(ROUTES)("should never remove what the %s route sets", (route) => {
      // Arrange — every credential to hand, so each route injects its full set.
      const added = buildClaudeEnv({
        env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
        route,
        bedrockKey: BEDROCK_KEY,
        claudeToken: CLAUDE_TOKEN,
        gateway: GATEWAY
      });

      // Act
      const clash = Object.keys(added).filter((name) => conflictingEnv(route).includes(name));

      // Assert
      expect(clash).toEqual([]);
    });

    it.each(ROUTES)("should leave the tuning variables the engineer is allowed to win on alone, on %s", (route) => {
      // Assert — AWS_REGION, the model names and the base url are deliberately not payer
      // facts; `existingOr` exists to let an engineer override them.
      expect([...conflictingEnv(route)]).not.toEqual(expect.arrayContaining(["AWS_REGION", "ANTHROPIC_BEDROCK_BASE_URL", ...Object.keys(DEFAULT_MODELS)]));
    });
  });

  describe("secret handling", () => {
    it.each<[Route, string]>([
      ["bedrock", BEDROCK_KEY],
      ["ai-gateway", APIM_KEY],
      ["agent-hub", CLAUDE_TOKEN]
    ])("should keep the %s secret out of every variable name", (route, secret) => {
      // Act
      const added = buildClaudeEnv({ env: {}, route, bedrockKey: BEDROCK_KEY, claudeToken: CLAUDE_TOKEN, gateway: GATEWAY });

      // Assert
      expect(Object.keys(added).join(" ")).not.toContain(secret);
    });
  });
});
