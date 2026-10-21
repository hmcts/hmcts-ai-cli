export const ROUTES = ["bedrock", "gateway", "own-licence"] as const;

export const REMEDIES = [
  "ask in the DTSSE channel for an Amazon Bedrock API key, then run hai again and paste it when prompted",
  "run hai with HAI_ROUTE=gateway to go through the HMCTS AI Gateway instead (needs az login and the F5 VPN)",
  "run `claude setup-token` on your own Claude licence and export the result as CLAUDE_CODE_OAUTH_TOKEN, or run HAI_ROUTE=own-licence"
];

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
  if (signals.hasOauthEnvToken) {
    return { route: "own-licence", credentialSource: "env", reasons: ["CLAUDE_CODE_OAUTH_TOKEN is set"] };
  }
  if (signals.hasStoredBedrockKey) {
    return { route: "bedrock", credentialSource: "agent-hub", reasons: ["agent-hub holds a Bedrock API key for you"] };
  }
  if (signals.hasHostClaudeCredential) {
    return { route: "own-licence", credentialSource: "host-oauth", reasons: ["this machine has a live claude.ai login"] };
  }
  if (signals.isBedrockGroupMember === true) {
    return { route: "bedrock", credentialSource: "prompt", reasons: ["you are in the Bedrock developer group but no key is stored"] };
  }
  if (signals.isBedrockGroupMember === null) {
    // Unknown membership (offline, or az could not answer) still gets the prompt: a key
    // pasted by hand works regardless, and failing here would be a guess either way.
    return { route: "bedrock", credentialSource: "prompt", reasons: ["no stored Bedrock key, and Bedrock group membership could not be checked"] };
  }
  return {
    route: "bedrock",
    credentialSource: "unavailable",
    reasons: ["no Bedrock key in the environment or on agent-hub, no claude.ai login, and you are not in the Bedrock developer group"]
  };
}

function explicit(signals: Signals, route: Route): RouteResolution {
  const reasons = [`HAI_ROUTE=${route}`];
  if (route === "gateway") {
    return { route, credentialSource: "gateway-apim", reasons };
  }
  if (route === "own-licence") {
    if (signals.hasOauthEnvToken) {
      return { route, credentialSource: "env", reasons: [...reasons, "CLAUDE_CODE_OAUTH_TOKEN is set"] };
    }
    return { route, credentialSource: "host-oauth", reasons };
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

/** "unavailable" is the no-signal case: the caller fails and prints every remedy. */
export type CredentialSource = "env" | "agent-hub" | "host-oauth" | "prompt" | "gateway-apim" | "unavailable";

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
