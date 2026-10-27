/**
 * One credential from one source each, which is what makes "an explicit HAI_ROUTE is
 * obeyed" expressible at all: `bedrock` used to mean an environment key *or* a key
 * agent-hub holds *or* a key pasted at a prompt, so there was no way to name a single
 * thing for hai to go and get.
 */
export const ROUTES = ["agent-hub", "byol", "ai-gateway", "bedrock"] as const;

/**
 * The names these two replaced, kept only to fail by name. No aliases: `gateway` is the
 * worse of the two, because cft-workspace's `AGENT_HUB_MODEL_ROUTE=gateway` is a legacy
 * alias for **Bedrock** while hai's `gateway` meant the AI Gateway — the same word with
 * opposite meanings in two files that are read together.
 */
export const RENAMED_ROUTES: Record<string, Route> = {
  "own-licence": "byol",
  gateway: "ai-gateway"
};

/**
 * Said on every launch, not under `HAI_VERBOSE`. Two routes bill a personal Claude licence
 * and two bill HMCTS, and the name does not say which; now that an explicit `HAI_ROUTE` is
 * obeyed with no fallbacks, this line is the only thing left that catches an `HAI_ROUTE`
 * typed deliberately on day one and forgotten in a shell profile by day ten.
 */
export const BILLED_TO: Record<Route, string> = {
  "agent-hub": "the personal Claude licence agent-hub holds a token for, not HMCTS",
  byol: "your own Claude licence, not HMCTS",
  "ai-gateway": "HMCTS, through the AI Gateway",
  bedrock: "HMCTS, through Amazon Bedrock"
};

export const REMEDIES = [
  "ask in the DTSSE channel for an Amazon Bedrock API key, then run hai again and paste it when prompted",
  "run hai with HAI_ROUTE=ai-gateway to go through the HMCTS AI Gateway instead (needs az login and the F5 VPN)",
  "run `claude setup-token` on your own Claude licence and export the result as CLAUDE_CODE_OAUTH_TOKEN, or run HAI_ROUTE=byol"
];

export const UNKNOWN_MEMBERSHIP_REFUSAL =
  "your Bedrock developer group membership could not be confirmed, so hai will not spend your personal claude.ai subscription by accident. Run az login with the F5 VPN up and try again, or set HAI_ROUTE=byol if billing your own subscription is genuinely what you want.";

/** Offline there is nothing to retry: az and Graph were skipped because that is what the flag asks for. */
export const OFFLINE_MEMBERSHIP_REFUSAL =
  "HAI_OFFLINE=1, so your Bedrock developer group membership could not be checked and hai will not spend your personal claude.ai subscription by accident. Set HAI_ROUTE=byol if billing your own subscription is genuinely what you want, or drop HAI_OFFLINE to let hai check the group.";

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

/** What to say about an `HAI_ROUTE` that is not a route, naming the replacement when there is one. */
export function badRouteMessage(value: string): string {
  const replacement = RENAMED_ROUTES[value];
  if (replacement !== undefined) {
    return `HAI_ROUTE=${value} no longer exists; it is now HAI_ROUTE=${replacement}`;
  }
  return `HAI_ROUTE=${value} is not a route; use one of ${ROUTES.join(", ")}`;
}

/** The line every launch prints, so nobody has to remember which routes HMCTS pays for. */
export function billingNote(route: Route): string {
  return `route ${route} — paid for by ${BILLED_TO[route]}`;
}

/**
 * Pure over gathered signals, so the precedence table is testable without any I/O.
 * First match wins, in the order of the table in the README.
 */
export function resolveRoute(signals: Signals): RouteResolution {
  // `byName` is stamped once here rather than woven through every branch. It is not the
  // same question as `credentialSource`, which says what the signals concluded: a named
  // route may only read its one source, while the unset path may walk env → agent-hub →
  // prompt for a Bedrock key however it got here, the AI-Gateway downgrade included.
  return { ...decided(signals), byName: signals.requestedRoute !== null };
}

function decided(signals: Signals): Omit<RouteResolution, "byName"> {
  if (signals.requestedRoute !== null) {
    return explicit(signals, signals.requestedRoute);
  }
  if (signals.isBedrockGroupMember === true) {
    // First on the unset path, ahead of the Bedrock keys as well as every personal
    // credential. The gateway is the route HMCTS manages — quotas, model allow-lists,
    // content safety and per-service cost attribution — so for a member it is the answer
    // whatever keys happen to be lying around. A member whose gateway cannot be reached
    // still ends up on Bedrock: `resolveAuth` downgrades, and the key chain it walks is
    // the same env → agent-hub → prompt as before.
    return { route: "ai-gateway", credentialSource: "gateway-apim", reasons: ["you are in the Bedrock developer group, so HMCTS pays for this session"] };
  }
  if (signals.hasBedrockEnvKey) {
    return { route: "bedrock", credentialSource: "env", reasons: ["AWS_BEARER_TOKEN_BEDROCK is set"] };
  }
  if (signals.hasStoredBedrockKey) {
    return { route: "bedrock", credentialSource: "agent-hub", reasons: ["agent-hub holds a Bedrock API key for you"] };
  }
  if (signals.isBedrockGroupMember === null) {
    return unknownMembership(signals);
  }
  if (signals.hasOauthEnvToken) {
    return { route: "byol", credentialSource: "env", reasons: ["you are not in the Bedrock developer group, and CLAUDE_CODE_OAUTH_TOKEN is set"] };
  }
  if (signals.hasHostClaudeCredential) {
    return {
      route: "byol",
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
function unknownMembership(signals: Signals): Omit<RouteResolution, "byName"> {
  if (signals.hasOauthEnvToken || signals.hasHostClaudeCredential) {
    // The refusal stands offline, but telling someone who asked for no lookups to go and
    // run az login is advice against their own flag.
    const refusal = signals.offline ? OFFLINE_MEMBERSHIP_REFUSAL : UNKNOWN_MEMBERSHIP_REFUSAL;
    return { route: "byol", credentialSource: "refused", reasons: [refusal] };
  }
  // Nothing personal to fall back to, so the only thing left is a key pasted by hand,
  // and offering that spends nobody's own subscription.
  return { route: "bedrock", credentialSource: "prompt", reasons: ["no stored Bedrock key, and Bedrock group membership could not be checked"] };
}

/**
 * A typed `HAI_ROUTE` is a choice, so it is obeyed: one credential, one source, and a
 * failure naming that source when it cannot be had. Nothing here refuses and nothing here
 * falls through to a second source — the group check above guards the *accident*, which is
 * the unset path, and refusing a deliberate act only taught people to go round it.
 */
function explicit(signals: Signals, route: Route): Omit<RouteResolution, "byName"> {
  const reasons = [`HAI_ROUTE=${route}`];
  if (route === "agent-hub") {
    return { route, credentialSource: "agent-hub", reasons: [...reasons, "the Claude token agent-hub holds for you"] };
  }
  if (route === "byol") {
    if (signals.hasOauthEnvToken) {
      return { route, credentialSource: "env", reasons: [...reasons, "CLAUDE_CODE_OAUTH_TOKEN is set"] };
    }
    return { route, credentialSource: "host-oauth", reasons: [...reasons, "the claude.ai login on this machine"] };
  }
  if (route === "ai-gateway") {
    return { route, credentialSource: "gateway-apim", reasons };
  }
  if (signals.hasBedrockEnvKey) {
    return { route, credentialSource: "env", reasons: [...reasons, "AWS_BEARER_TOKEN_BEDROCK is set"] };
  }
  return { route, credentialSource: "prompt", reasons: [...reasons, "no AWS_BEARER_TOKEN_BEDROCK in the environment, so hai asks for one"] };
}

export type Route = (typeof ROUTES)[number];

/**
 * "unavailable" is the no-signal case: the caller fails and prints every remedy.
 * "refused" names a route hai will not take at all; the caller fails with the reasons,
 * which already say what to do instead. Only the unset path can produce either.
 */
export type CredentialSource = "env" | "agent-hub" | "host-oauth" | "prompt" | "gateway-apim" | "unavailable" | "refused";

export interface Signals {
  requestedRoute: Route | null;
  hasBedrockEnvKey: boolean;
  hasOauthEnvToken: boolean;
  hasStoredBedrockKey: boolean;
  hasHostClaudeCredential: boolean;
  isBedrockGroupMember: boolean | null;
  /** HAI_OFFLINE=1. It decides no route, only how an unconfirmable membership is explained. */
  offline: boolean;
}

export interface RouteResolution {
  route: Route;
  credentialSource: CredentialSource;
  reasons: string[];
  /**
   * True when `HAI_ROUTE` asked for this route by name, which is what decides how far the
   * credential fetch may look: a named route reads its one source, the unset path reads the
   * chain. Distinct from `credentialSource`, which only reports what the signals concluded.
   */
  byName: boolean;
}
