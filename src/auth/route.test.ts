import { describe, expect, it } from "vitest";
import {
  BILLED_TO,
  badRouteMessage,
  billingNote,
  type CredentialSource,
  isRoute,
  OFFLINE_MEMBERSHIP_REFUSAL,
  REMEDIES,
  RENAMED_ROUTES,
  ROUTES,
  type Route,
  resolveRoute,
  type Signals,
  UNKNOWN_MEMBERSHIP_REFUSAL
} from "./route.js";

const NOTHING: Signals = {
  requestedRoute: null,
  hasBedrockEnvKey: false,
  hasOauthEnvToken: false,
  hasStoredBedrockKey: false,
  hasHostClaudeCredential: false,
  isBedrockGroupMember: false,
  offline: false
};

const MEMBER: Partial<Signals> = { isBedrockGroupMember: true };
const NON_MEMBER: Partial<Signals> = { isBedrockGroupMember: false };
const UNKNOWN: Partial<Signals> = { isBedrockGroupMember: null };

/** Every signal on at once, which is how a row proves a route ignores all of them. */
const EVERYTHING: Partial<Signals> = {
  hasBedrockEnvKey: true,
  hasOauthEnvToken: true,
  hasStoredBedrockKey: true,
  hasHostClaudeCredential: true
};

function signals(overrides: Partial<Signals>): Signals {
  return { ...NOTHING, ...overrides };
}

type Row = [string, Partial<Signals>, Route, CredentialSource];

describe("isRoute", () => {
  it.each([
    ["agent-hub", true],
    ["byol", true],
    ["ai-gateway", true],
    ["bedrock", true],
    ["own-licence", false],
    ["gateway", false],
    ["", false],
    ["Bedrock", false]
  ])("should report %s as a route: %s", (value, expected) => {
    // Act
    const result = isRoute(value);

    // Assert
    expect(result).toBe(expected);
  });
});

describe("badRouteMessage", () => {
  it.each<[string, Route]>([
    ["own-licence", "byol"],
    ["gateway", "ai-gateway"]
  ])("should name the replacement for the old %s rather than accept it", (old, replacement) => {
    // Act
    const message = badRouteMessage(old);

    // Assert — a hard break: `gateway` means Bedrock in cft-workspace and the AI Gateway
    // here, so an alias would keep two opposite meanings of one word alive.
    expect(message).toContain(`HAI_ROUTE=${old} no longer exists`);
    expect(message).toContain(`HAI_ROUTE=${replacement}`);
    expect(RENAMED_ROUTES[old]).toBe(replacement);
  });

  it("should list the real routes for a name that was never one", () => {
    // Act
    const message = badRouteMessage("own_licence");

    // Assert
    expect(message).toBe("HAI_ROUTE=own_licence is not a route; use one of agent-hub, byol, ai-gateway, bedrock");
  });
});

describe("billingNote", () => {
  it.each<[Route, string]>([
    ["agent-hub", "not HMCTS"],
    ["byol", "not HMCTS"],
    ["ai-gateway", "HMCTS"],
    ["bedrock", "HMCTS"]
  ])("should say who pays for %s", (route, who) => {
    // Act
    const note = billingNote(route);

    // Assert
    expect(note).toContain(`route ${route}`);
    expect(note).toContain(who);
  });

  it("should have an answer for every route, because the line is unconditional", () => {
    // Assert
    expect(Object.keys(BILLED_TO).sort()).toEqual([...ROUTES].sort());
  });
});

describe("resolveRoute", () => {
  describe("an explicit HAI_ROUTE", () => {
    it.each<Row>([
      ["agent-hub, from the hub's claude kind", { requestedRoute: "agent-hub" }, "agent-hub", "agent-hub"],
      ["byol, from an exported CLAUDE_CODE_OAUTH_TOKEN", { requestedRoute: "byol", hasOauthEnvToken: true }, "byol", "env"],
      ["byol, from the claude.ai login on this machine", { requestedRoute: "byol" }, "byol", "host-oauth"],
      ["ai-gateway, from the APIM key in the Key Vault", { requestedRoute: "ai-gateway" }, "ai-gateway", "gateway-apim"],
      ["bedrock, from AWS_BEARER_TOKEN_BEDROCK", { requestedRoute: "bedrock", hasBedrockEnvKey: true }, "bedrock", "env"],
      ["bedrock, from a key pasted by hand", { requestedRoute: "bedrock" }, "bedrock", "prompt"]
    ])("should resolve %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
      expect(result.reasons[0]).toBe(`HAI_ROUTE=${route}`);
    });

    it.each<[Route, CredentialSource]>([
      ["agent-hub", "agent-hub"],
      ["byol", "env"],
      ["ai-gateway", "gateway-apim"],
      ["bedrock", "env"]
    ])("should obey %s whatever every other signal says", (route, credentialSource) => {
      // Act — a key in the environment, a key on the hub, an exported token and a host
      // login, all at once, against each named route.
      const result = resolveRoute(signals({ ...EVERYTHING, requestedRoute: route }));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
    });

    it.each<[string, Partial<Signals>]>([
      ["a confirmed member", MEMBER],
      ["a confirmed non-member", NON_MEMBER],
      ["membership that could not be checked", UNKNOWN]
    ])("should refuse nothing and fall back to nothing for %s", (_name, membership) => {
      // Act — every route against every membership answer.
      const results = ROUTES.map((requestedRoute) => resolveRoute(signals({ ...membership, requestedRoute })));

      // Assert — a named route is a deliberate act; the group check guards the accident,
      // which is the unset path. Refusing this only taught people to go round it.
      expect(results.map((result) => result.route)).toEqual([...ROUTES]);
      expect(results.filter((result) => result.credentialSource === "refused" || result.credentialSource === "unavailable")).toEqual([]);
    });

    it("should ignore a Bedrock key on agent-hub, which is no longer one of bedrock's sources", () => {
      // Act
      const result = resolveRoute(signals({ requestedRoute: "bedrock", hasStoredBedrockKey: true }));

      // Assert — one route, one source: the env or a paste, and the hub serves the default path.
      expect(result).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
    });
  });

  describe("a confirmed group member, with no HAI_ROUTE", () => {
    it.each<Row>([
      ["nothing else at all", MEMBER, "ai-gateway", "gateway-apim"],
      ["a live host claude.ai login, which every Claude Code user has", { ...MEMBER, hasHostClaudeCredential: true }, "ai-gateway", "gateway-apim"],
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { ...MEMBER, hasOauthEnvToken: true }, "ai-gateway", "gateway-apim"],
      ["both personal credentials at once", { ...MEMBER, hasOauthEnvToken: true, hasHostClaudeCredential: true }, "ai-gateway", "gateway-apim"],
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
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { ...NON_MEMBER, hasOauthEnvToken: true }, "byol", "env"],
      ["a live host claude.ai login", { ...NON_MEMBER, hasHostClaudeCredential: true }, "byol", "host-oauth"],
      ["an exported token ahead of a host login", { ...NON_MEMBER, hasOauthEnvToken: true, hasHostClaudeCredential: true }, "byol", "env"],
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
      ["a live host claude.ai login", { ...UNKNOWN, hasHostClaudeCredential: true }, "byol", "refused"],
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { ...UNKNOWN, hasOauthEnvToken: true }, "byol", "refused"],
      ["both personal credentials at once", { ...UNKNOWN, hasOauthEnvToken: true, hasHostClaudeCredential: true }, "byol", "refused"],
      ["nothing personal to fall back to", UNKNOWN, "bedrock", "prompt"]
    ])("should resolve %s", (_name, overrides, route, credentialSource) => {
      // Act
      const result = resolveRoute(signals(overrides));

      // Assert
      expect(result).toMatchObject({ route, credentialSource });
    });

    it("should name HAI_ROUTE=byol as the way to say that is genuinely what you want", () => {
      // Act
      const result = resolveRoute(signals({ ...UNKNOWN, hasHostClaudeCredential: true }));

      // Assert
      expect(result.reasons.join(" ")).toContain("HAI_ROUTE=byol");
      expect(result.reasons.join(" ")).toBe(UNKNOWN_MEMBERSHIP_REFUSAL);
    });

    it.each<[string, Partial<Signals>]>([
      ["an exported CLAUDE_CODE_OAUTH_TOKEN", { hasOauthEnvToken: true }],
      ["a live host claude.ai login", { hasHostClaudeCredential: true }]
    ])("should refuse offline with %s without advising az login, which HAI_OFFLINE opted out of", (_name, personal) => {
      // Act
      const result = resolveRoute(signals({ ...UNKNOWN, ...personal, offline: true }));

      // Assert
      expect(result).toMatchObject({ route: "byol", credentialSource: "refused", reasons: [OFFLINE_MEMBERSHIP_REFUSAL] });
      expect(OFFLINE_MEMBERSHIP_REFUSAL).toContain("HAI_ROUTE=byol");
      expect(OFFLINE_MEMBERSHIP_REFUSAL).not.toMatch(/az login|VPN/);
    });
  });

  describe("the hard block on the unset path", () => {
    const BOOLEANS: (keyof Signals)[] = ["hasBedrockEnvKey", "hasOauthEnvToken", "hasStoredBedrockKey", "hasHostClaudeCredential"];

    // Arrange — every combination of the four credential signals, with no HAI_ROUTE.
    const combinations = Array.from({ length: 1 << BOOLEANS.length }, (_unused, mask) =>
      Object.fromEntries(BOOLEANS.map((name, bit) => [name, (mask & (1 << bit)) !== 0]))
    );

    it("should never route a confirmed member to a personal licence, by any path it chose itself", () => {
      // Act
      const results = combinations.map((overrides) => resolveRoute(signals({ ...overrides, ...MEMBER })));

      // Assert
      expect(results.filter((result) => result.route === "byol" || result.route === "agent-hub")).toEqual([]);
    });

    it("should never reach a personal credential implicitly when membership is unknown", () => {
      // Act
      const results = combinations.map((overrides) => resolveRoute(signals({ ...overrides, ...UNKNOWN })));

      // Assert
      expect(results.filter((result) => result.route === "byol" && result.credentialSource !== "refused")).toEqual([]);
    });

    it("should keep the group check ahead of every personal-credential branch", () => {
      // Act — the incident's shape: a member with a live claude.ai login and no Bedrock key.
      const result = resolveRoute(signals({ ...MEMBER, hasOauthEnvToken: true, hasHostClaudeCredential: true }));

      // Assert
      expect(result.route).toBe("ai-gateway");
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

    it("should offer three remedies, each naming a route that still exists", () => {
      // Assert
      expect(REMEDIES).toHaveLength(3);
      expect(REMEDIES.join(" ")).toContain("HAI_ROUTE=ai-gateway");
      expect(REMEDIES.join(" ")).toContain("HAI_ROUTE=byol");
      expect(REMEDIES.join(" ")).not.toMatch(/HAI_ROUTE=(gateway|own-licence)\b/);
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

    it("should say nothing but the request for a route whose source cannot vary", () => {
      // Act
      const result = resolveRoute(signals({ ...EVERYTHING, requestedRoute: "ai-gateway" }));

      // Assert
      expect(result.reasons).toEqual(["HAI_ROUTE=ai-gateway"]);
    });

    it("should say HMCTS is paying when the group put the session on the gateway", () => {
      // Act
      const result = resolveRoute(signals(MEMBER));

      // Assert
      expect(result.reasons).toEqual(["you are in the Bedrock developer group, so HMCTS pays for this session"]);
    });
  });
});
