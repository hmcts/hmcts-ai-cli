import { describe, expect, it } from "vitest";
import { isRoute, REMEDIES, type Route, resolveRoute, type Signals } from "./route.js";

const NOTHING: Signals = {
  requestedRoute: null,
  hasBedrockEnvKey: false,
  hasOauthEnvToken: false,
  hasStoredBedrockKey: false,
  hasHostClaudeCredential: false,
  isBedrockGroupMember: false
};

function signals(overrides: Partial<Signals>): Signals {
  return { ...NOTHING, ...overrides };
}

describe("isRoute", () => {
  it.each([
    ["bedrock", true],
    ["gateway", true],
    ["own-licence", true],
    ["own_licence", false],
    ["", false],
    ["Bedrock", false]
  ])("should report %s as a route: %s", (value, expected) => {
    // Act
    const result = isRoute(value);

    // Assert
    expect(result).toBe(expected);
  });
});

describe("resolveRoute", () => {
  describe("row 1 — HAI_ROUTE wins outright", () => {
    it.each<[Route, Partial<Signals>, string]>([
      ["bedrock", {}, "prompt"],
      ["bedrock", { hasBedrockEnvKey: true }, "env"],
      ["bedrock", { hasStoredBedrockKey: true }, "agent-hub"],
      ["bedrock", { hasBedrockEnvKey: true, hasStoredBedrockKey: true }, "env"],
      ["gateway", {}, "gateway-apim"],
      ["gateway", { hasBedrockEnvKey: true, hasOauthEnvToken: true, hasStoredBedrockKey: true }, "gateway-apim"],
      ["own-licence", {}, "host-oauth"],
      ["own-licence", { hasOauthEnvToken: true }, "env"],
      ["own-licence", { hasBedrockEnvKey: true, hasStoredBedrockKey: true }, "host-oauth"]
    ])("should honour HAI_ROUTE=%s and take its credential from %o -> %s", (route, overrides, credentialSource) => {
      // Arrange
      const input = signals({ ...overrides, requestedRoute: route });

      // Act
      const result = resolveRoute(input);

      // Assert
      expect(result.route).toBe(route);
      expect(result.credentialSource).toBe(credentialSource);
      expect(result.reasons[0]).toBe(`HAI_ROUTE=${route}`);
    });

    it("should still name an explicit route when every other signal points elsewhere", () => {
      // Arrange
      const input = signals({ requestedRoute: "own-licence", hasBedrockEnvKey: true, hasStoredBedrockKey: true, isBedrockGroupMember: true });

      // Act
      const result = resolveRoute(input);

      // Assert
      expect(result.route).toBe("own-licence");
    });
  });

  describe("rows 2-6 — precedence with no HAI_ROUTE", () => {
    it.each<[string, Partial<Signals>, Route, string]>([
      ["row 2: a Bedrock key in the environment", { hasBedrockEnvKey: true }, "bedrock", "env"],
      ["row 2 beats row 3", { hasBedrockEnvKey: true, hasOauthEnvToken: true }, "bedrock", "env"],
      [
        "row 2 beats rows 4-6",
        { hasBedrockEnvKey: true, hasStoredBedrockKey: true, hasHostClaudeCredential: true, isBedrockGroupMember: true },
        "bedrock",
        "env"
      ],
      ["row 3: an OAuth token in the environment", { hasOauthEnvToken: true }, "own-licence", "env"],
      [
        "row 3 beats rows 4-6",
        { hasOauthEnvToken: true, hasStoredBedrockKey: true, hasHostClaudeCredential: true, isBedrockGroupMember: true },
        "own-licence",
        "env"
      ],
      ["row 4: agent-hub holds a key", { hasStoredBedrockKey: true }, "bedrock", "agent-hub"],
      ["row 4 beats rows 5-6", { hasStoredBedrockKey: true, hasHostClaudeCredential: true, isBedrockGroupMember: true }, "bedrock", "agent-hub"],
      ["row 5: a live host claude.ai login", { hasHostClaudeCredential: true }, "own-licence", "host-oauth"],
      ["row 5 beats row 6", { hasHostClaudeCredential: true, isBedrockGroupMember: true }, "own-licence", "host-oauth"],
      ["row 6: in the Bedrock group with no key", { isBedrockGroupMember: true }, "bedrock", "prompt"],
      ["row 6 with unknown membership still prompts", { isBedrockGroupMember: null }, "bedrock", "prompt"]
    ])("should resolve %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result.route).toBe(route);
      expect(result.credentialSource).toBe(credentialSource);
      expect(result.reasons).not.toHaveLength(0);
    });
  });

  describe("row 7 — nothing at all", () => {
    it("should report the credential as unavailable when no signal fires and membership is denied", () => {
      // Act
      const result = resolveRoute(NOTHING);

      // Assert
      expect(result.credentialSource).toBe("unavailable");
      expect(result.reasons.join(" ")).toContain("not in the Bedrock developer group");
    });

    it("should offer three remedies", () => {
      // Assert
      expect(REMEDIES).toHaveLength(3);
    });

    it("should not cite a documentation url for how a Bedrock key is issued", () => {
      // Assert
      expect(REMEDIES.join(" ")).not.toMatch(/https?:\/\//);
      expect(REMEDIES[0]).toContain("DTSSE channel");
    });
  });

  describe("reasons", () => {
    it("should say why, in the order the signals were considered", () => {
      // Act
      const result = resolveRoute(signals({ requestedRoute: "bedrock", hasBedrockEnvKey: true }));

      // Assert
      expect(result.reasons).toEqual(["HAI_ROUTE=bedrock", "AWS_BEARER_TOKEN_BEDROCK is set"]);
    });
  });
});
