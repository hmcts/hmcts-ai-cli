import { describe, expect, it } from "vitest";
import { type CredentialSource, isRoute, MEMBER_REFUSAL, REMEDIES, type Route, resolveRoute, type Signals, UNKNOWN_MEMBERSHIP_REFUSAL } from "./route.js";

const NOTHING: Signals = {
  requestedRoute: null,
  hasBedrockEnvKey: false,
  hasOauthEnvToken: false,
  hasStoredBedrockKey: false,
  hasHostClaudeCredential: false,
  isBedrockGroupMember: false
};

const MEMBER: Partial<Signals> = { isBedrockGroupMember: true };
const NON_MEMBER: Partial<Signals> = { isBedrockGroupMember: false };
const UNKNOWN: Partial<Signals> = { isBedrockGroupMember: null };

function signals(overrides: Partial<Signals>): Signals {
  return { ...NOTHING, ...overrides };
}

type Row = [string, Partial<Signals>, Route, CredentialSource];

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
  describe("a confirmed group member, with no HAI_ROUTE", () => {
    it.each<Row>([
      ["nothing else at all", MEMBER, "gateway", "gateway-apim"],
      ["a live host claude.ai login, which every Claude Code user has", { ...MEMBER, hasHostClaudeCredential: true }, "gateway", "gateway-apim"],
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { ...MEMBER, hasOauthEnvToken: true }, "gateway", "gateway-apim"],
      ["both personal credentials at once", { ...MEMBER, hasOauthEnvToken: true, hasHostClaudeCredential: true }, "gateway", "gateway-apim"],
      ["a Bedrock key in the environment", { ...MEMBER, hasBedrockEnvKey: true }, "bedrock", "env"],
      ["a Bedrock key on agent-hub", { ...MEMBER, hasStoredBedrockKey: true }, "bedrock", "agent-hub"],
      ["both Bedrock keys", { ...MEMBER, hasBedrockEnvKey: true, hasStoredBedrockKey: true }, "bedrock", "env"],
      ["a stored key and a host login", { ...MEMBER, hasStoredBedrockKey: true, hasHostClaudeCredential: true }, "bedrock", "agent-hub"]
    ])("should resolve %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
    });
  });

  describe("a confirmed non-member, with no HAI_ROUTE", () => {
    it.each<Row>([
      ["a Bedrock key in the environment", { ...NON_MEMBER, hasBedrockEnvKey: true }, "bedrock", "env"],
      ["a Bedrock key on agent-hub", { ...NON_MEMBER, hasStoredBedrockKey: true }, "bedrock", "agent-hub"],
      ["a stored key ahead of a host login", { ...NON_MEMBER, hasStoredBedrockKey: true, hasHostClaudeCredential: true }, "bedrock", "agent-hub"],
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { ...NON_MEMBER, hasOauthEnvToken: true }, "own-licence", "env"],
      ["a live host claude.ai login", { ...NON_MEMBER, hasHostClaudeCredential: true }, "own-licence", "host-oauth"],
      ["an exported token ahead of a host login", { ...NON_MEMBER, hasOauthEnvToken: true, hasHostClaudeCredential: true }, "own-licence", "env"],
      ["an environment key ahead of an exported token", { ...NON_MEMBER, hasBedrockEnvKey: true, hasOauthEnvToken: true }, "bedrock", "env"],
      ["nothing at all", NON_MEMBER, "bedrock", "unavailable"]
    ])("should resolve %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
    });
  });

  describe("membership that could not be checked, with no HAI_ROUTE", () => {
    it.each<Row>([
      ["a Bedrock key in the environment", { ...UNKNOWN, hasBedrockEnvKey: true }, "bedrock", "env"],
      ["a Bedrock key on agent-hub", { ...UNKNOWN, hasStoredBedrockKey: true }, "bedrock", "agent-hub"],
      ["a stored key ahead of a host login", { ...UNKNOWN, hasStoredBedrockKey: true, hasHostClaudeCredential: true }, "bedrock", "agent-hub"],
      ["a live host claude.ai login", { ...UNKNOWN, hasHostClaudeCredential: true }, "own-licence", "refused"],
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { ...UNKNOWN, hasOauthEnvToken: true }, "own-licence", "refused"],
      ["both personal credentials at once", { ...UNKNOWN, hasOauthEnvToken: true, hasHostClaudeCredential: true }, "own-licence", "refused"],
      ["nothing personal to fall back to", UNKNOWN, "bedrock", "prompt"]
    ])("should resolve %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
    });

    it("should name HAI_ROUTE=own-licence as the way to say that is genuinely what you want", () => {
      // Act
      const result = resolveRoute(signals({ ...UNKNOWN, hasHostClaudeCredential: true }));

      // Assert
      expect(result.reasons.join(" ")).toContain("HAI_ROUTE=own-licence");
      expect(result.reasons.join(" ")).toBe(UNKNOWN_MEMBERSHIP_REFUSAL);
    });
  });

  describe("HAI_ROUTE=bedrock", () => {
    it.each<Row>([
      ["a member with nothing stored", { ...MEMBER, requestedRoute: "bedrock" }, "bedrock", "prompt"],
      ["a non-member with nothing stored", { ...NON_MEMBER, requestedRoute: "bedrock" }, "bedrock", "prompt"],
      ["unknown membership with nothing stored", { ...UNKNOWN, requestedRoute: "bedrock" }, "bedrock", "prompt"],
      ["a key in the environment", { requestedRoute: "bedrock", hasBedrockEnvKey: true }, "bedrock", "env"],
      ["a key on agent-hub", { requestedRoute: "bedrock", hasStoredBedrockKey: true }, "bedrock", "agent-hub"],
      ["both keys", { requestedRoute: "bedrock", hasBedrockEnvKey: true, hasStoredBedrockKey: true }, "bedrock", "env"],
      ["personal credentials, which it ignores", { requestedRoute: "bedrock", hasOauthEnvToken: true, hasHostClaudeCredential: true }, "bedrock", "prompt"]
    ])("should honour it given %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
      expect(result.reasons[0]).toBe("HAI_ROUTE=bedrock");
    });
  });

  describe("HAI_ROUTE=gateway", () => {
    it.each<Row>([
      ["a member", { ...MEMBER, requestedRoute: "gateway" }, "gateway", "gateway-apim"],
      ["a non-member", { ...NON_MEMBER, requestedRoute: "gateway" }, "gateway", "gateway-apim"],
      ["unknown membership", { ...UNKNOWN, requestedRoute: "gateway" }, "gateway", "gateway-apim"],
      [
        "every other signal pointing elsewhere",
        { requestedRoute: "gateway", hasBedrockEnvKey: true, hasOauthEnvToken: true, hasStoredBedrockKey: true, hasHostClaudeCredential: true },
        "gateway",
        "gateway-apim"
      ]
    ])("should honour it for %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
      expect(result.reasons).toEqual(["HAI_ROUTE=gateway"]);
    });
  });

  describe("HAI_ROUTE=own-licence", () => {
    it.each<Row>([
      ["a member asking for it by name", { ...MEMBER, requestedRoute: "own-licence" }, "own-licence", "refused"],
      ["a member with an exported token", { ...MEMBER, requestedRoute: "own-licence", hasOauthEnvToken: true }, "own-licence", "refused"],
      ["a member with a host login", { ...MEMBER, requestedRoute: "own-licence", hasHostClaudeCredential: true }, "own-licence", "refused"],
      ["a member who also has a Bedrock key", { ...MEMBER, requestedRoute: "own-licence", hasBedrockEnvKey: true }, "own-licence", "refused"],
      ["a non-member on a host login", { ...NON_MEMBER, requestedRoute: "own-licence" }, "own-licence", "host-oauth"],
      ["a non-member with an exported token", { ...NON_MEMBER, requestedRoute: "own-licence", hasOauthEnvToken: true }, "own-licence", "env"],
      ["unknown membership, which is a deliberate choice", { ...UNKNOWN, requestedRoute: "own-licence" }, "own-licence", "host-oauth"],
      ["unknown membership with an exported token", { ...UNKNOWN, requestedRoute: "own-licence", hasOauthEnvToken: true }, "own-licence", "env"],
      ["unknown membership with a host login", { ...UNKNOWN, requestedRoute: "own-licence", hasHostClaudeCredential: true }, "own-licence", "host-oauth"]
    ])("should answer %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
    });

    it("should say why a member is refused, and what to run instead", () => {
      // Act
      const result = resolveRoute(signals({ ...MEMBER, requestedRoute: "own-licence" }));

      // Assert
      expect(result.reasons).toEqual(["HAI_ROUTE=own-licence", MEMBER_REFUSAL]);
      expect(MEMBER_REFUSAL).toContain("HMCTS funds your Claude usage");
      expect(MEMBER_REFUSAL).toContain("HAI_ROUTE=bedrock");
    });
  });

  describe("the hard block", () => {
    const BOOLEANS: (keyof Signals)[] = ["hasBedrockEnvKey", "hasOauthEnvToken", "hasStoredBedrockKey", "hasHostClaudeCredential"];
    const REQUESTS: (Route | null)[] = [null, "bedrock", "gateway", "own-licence"];

    // Arrange — every combination of the four credential signals against every HAI_ROUTE.
    const combinations = REQUESTS.flatMap((requestedRoute) =>
      Array.from({ length: 1 << BOOLEANS.length }, (_unused, mask) => ({
        requestedRoute,
        ...Object.fromEntries(BOOLEANS.map((name, bit) => [name, (mask & (1 << bit)) !== 0]))
      }))
    );

    it("should never route a confirmed member to a usable own licence, by any path", () => {
      // Act
      const results = combinations.map((overrides) => resolveRoute(signals({ ...overrides, ...MEMBER })));

      // Assert
      expect(results.filter((result) => result.route === "own-licence" && result.credentialSource !== "refused")).toEqual([]);
    });

    it("should never reach a personal credential implicitly when membership is unknown", () => {
      // Act
      const results = combinations
        .filter((overrides) => overrides.requestedRoute !== "own-licence")
        .map((overrides) => resolveRoute(signals({ ...overrides, ...UNKNOWN })));

      // Assert
      expect(results.filter((result) => result.route === "own-licence" && result.credentialSource !== "refused")).toEqual([]);
    });
  });

  describe("nothing at all", () => {
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

    it("should say HMCTS is paying when the group put the session on the gateway", () => {
      // Act
      const result = resolveRoute(signals(MEMBER));

      // Assert
      expect(result.reasons).toEqual(["you are in the Bedrock developer group, so HMCTS pays for this session"]);
    });
  });
});
