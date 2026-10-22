export const ROUTES = ["bedrock", "gateway", "own-licence"] as const;

export const REMEDIES = [
  "ask in the DTSSE channel for an Amazon Bedrock API key, then run hai again and paste it when prompted",
  "run hai with HAI_ROUTE=gateway to go through the HMCTS AI Gateway instead (needs az login and the F5 VPN)",
  "run `claude setup-token` on your own Claude licence and export the result as CLAUDE_CODE_OAUTH_TOKEN, or run HAI_ROUTE=own-licence"
];

/**
 * Why a member of the Bedrock developer group is never put on their own licence: HMCTS
 * already funds their capacity, so personal spend is both unnecessary and invisible — a
 * single session burned millions of tokens of someone's own claude.ai subscription before
 * anybody noticed.
 */
export const MEMBER_REFUSAL =
  "you are in the Bedrock developer group, so HMCTS funds your Claude usage and hai will not bill your personal claude.ai subscription, which is spend nobody sees. Run hai with no HAI_ROUTE to use the AI Gateway, or HAI_ROUTE=bedrock to paste a Bedrock API key.";

export const UNKNOWN_MEMBERSHIP_REFUSAL =
  "your Bedrock developer group membership could not be confirmed, so hai will not spend your personal claude.ai subscription by accident. Run az login with the F5 VPN up and try again, or set HAI_ROUTE=own-licence if billing your own subscription is genuinely what you want.";

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

/**
 * Pure over gathered signals, so the precedence table is testable without any I/O.
 * First match wins, in the order of the table in the README.
 */
export function resolveRoute(signals: Signals): RouteResolution {
  if (signals.requestedRoute !== null) {
    return explicit(signals, signals.requestedRoute);
  }
  if (signals.hasBedrockEnvKey) {
    return { route: "bedrock", credentialSource: "env", reasons: ["AWS_BEARER_TOKEN_BEDROCK is set"] };
  }
  if (signals.hasStoredBedrockKey) {
    return { route: "bedrock", credentialSource: "agent-hub", reasons: ["agent-hub holds a Bedrock API key for you"] };
  }
  if (signals.isBedrockGroupMember === true) {
    // Ahead of every personal-credential branch and unconditional: each Claude Code user
    // has a live claude.ai login, so testing for one first made this unreachable and a
    // missing Bedrock key quietly became "bill it to them".
    return { route: "gateway", credentialSource: "gateway-apim", reasons: ["you are in the Bedrock developer group, so HMCTS pays for this session"] };
  }
  if (signals.isBedrockGroupMember === null) {
    return unknownMembership(signals);
  }
  if (signals.hasOauthEnvToken) {
    return { route: "own-licence", credentialSource: "env", reasons: ["you are not in the Bedrock developer group, and CLAUDE_CODE_OAUTH_TOKEN is set"] };
  }
  if (signals.hasHostClaudeCredential) {
    return {
      route: "own-licence",
      credentialSource: "host-oauth",
      reasons: ["you are not in the Bedrock developer group, and this machine has a live claude.ai login"]
    };
  }
  return {
    route: "bedrock",
    credentialSource: "unavailable",
    reasons: ["no Bedrock key in the environment or on agent-hub, no claude.ai login, and you are not in the Bedrock developer group"]
  };
}

/** Never an implicit personal fallback: an unchecked membership is not evidence of a non-member. */
function unknownMembership(signals: Signals): RouteResolution {
  if (signals.hasOauthEnvToken || signals.hasHostClaudeCredential) {
    return { route: "own-licence", credentialSource: "refused", reasons: [UNKNOWN_MEMBERSHIP_REFUSAL] };
  }
  // Nothing personal to fall back to, so the only thing left is a key pasted by hand,
  // and offering that spends nobody's own subscription.
  return { route: "bedrock", credentialSource: "prompt", reasons: ["no stored Bedrock key, and Bedrock group membership could not be checked"] };
}

function explicit(signals: Signals, route: Route): RouteResolution {
  const reasons = [`HAI_ROUTE=${route}`];
  if (route === "own-licence") {
    // Asking for it by name is refused rather than ignored, so the engineer is told why.
    if (signals.isBedrockGroupMember === true) {
      return { route, credentialSource: "refused", reasons: [...reasons, MEMBER_REFUSAL] };
    }
    if (signals.hasOauthEnvToken) {
      return { route, credentialSource: "env", reasons: [...reasons, "CLAUDE_CODE_OAUTH_TOKEN is set"] };
    }
    return { route, credentialSource: "host-oauth", reasons };
  }
  if (route === "gateway") {
    return { route, credentialSource: "gateway-apim", reasons };
  }
  if (signals.hasBedrockEnvKey) {
    return { route, credentialSource: "env", reasons: [...reasons, "AWS_BEARER_TOKEN_BEDROCK is set"] };
  }
  if (signals.hasStoredBedrockKey) {
    return { route, credentialSource: "agent-hub", reasons: [...reasons, "agent-hub holds a Bedrock API key for you"] };
  }
  return { route, credentialSource: "prompt", reasons: [...reasons, "no Bedrock key in the environment or on agent-hub"] };
}

export type Route = (typeof ROUTES)[number];

/**
 * "unavailable" is the no-signal case: the caller fails and prints every remedy.
 * "refused" names a route hai will not take at all; the caller fails with the reasons,
 * which already say what to do instead.
 */
export type CredentialSource = "env" | "agent-hub" | "host-oauth" | "prompt" | "gateway-apim" | "unavailable" | "refused";

export interface Signals {
  requestedRoute: Route | null;
  hasBedrockEnvKey: boolean;
  hasOauthEnvToken: boolean;
  hasStoredBedrockKey: boolean;
  hasHostClaudeCredential: boolean;
  isBedrockGroupMember: boolean | null;
}

export interface RouteResolution {
  route: Route;
  credentialSource: CredentialSource;
  reasons: string[];
}
