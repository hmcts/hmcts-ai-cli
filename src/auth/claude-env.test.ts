import { describe, expect, it } from "vitest";
import { buildClaudeEnv, DEFAULT_AWS_REGION, DEFAULT_MODELS, GATEWAY_BEDROCK_BASE_URL } from "./claude-env.js";

const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
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

  describe("gateway", () => {
    it("should set the gateway variables, carrying the APIM key in a custom header", () => {
      // Act
      const added = buildClaudeEnv({ env: {}, route: "gateway", gateway: GATEWAY });

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
      const added = buildClaudeEnv({ env: {}, route: "gateway", gateway: GATEWAY });

      // Assert
      expect(added.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    });

    it("should let an existing base url win", () => {
      // Act
      const added = buildClaudeEnv({ env: { ANTHROPIC_BEDROCK_BASE_URL: "https://local/bedrock" }, route: "gateway", gateway: GATEWAY });

      // Assert
      expect(added.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://local/bedrock");
    });

    it("should refuse to build a gateway environment with no APIM key", () => {
      // Act / Assert
      expect(() => buildClaudeEnv({ env: {}, route: "gateway" })).toThrow("needs an APIM subscription key");
    });
  });

  describe("own-licence", () => {
    it("should set nothing, because the Bedrock variables would override the OAuth credential", () => {
      // Act
      const added = buildClaudeEnv({ env: {}, route: "own-licence", bedrockKey: BEDROCK_KEY, gateway: GATEWAY });

      // Assert
      expect(added).toEqual({});
    });
  });

  describe("secret handling", () => {
    it.each<["bedrock" | "gateway" | "own-licence", string]>([
      ["bedrock", BEDROCK_KEY],
      ["gateway", APIM_KEY]
    ])("should keep the %s secret out of every variable name", (route, secret) => {
      // Act
      const added = buildClaudeEnv({ env: {}, route, bedrockKey: BEDROCK_KEY, gateway: GATEWAY });

      // Assert
      expect(Object.keys(added).join(" ")).not.toContain(secret);
    });
  });
});
