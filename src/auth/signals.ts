import { checkBedrockGroupMembership } from "../az/group-membership.js";
import { messageOf } from "../log/error-message.js";
import type { Env } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";
import { hasHostClaudeCredential } from "./claude-credentials.js";
import { isRoute, ROUTES, type Route, type Signals } from "./route.js";

export function requestedRoute(env: Env): Route | null {
  const requested = env.HAI_ROUTE;
  if (requested === undefined || requested === "") {
    return null;
  }
  if (!isRoute(requested)) {
    throw new Error(`HAI_ROUTE=${requested} is not a route; use one of ${ROUTES.join(", ")}`);
  }
  return requested;
}

/**
 * False when the environment alone already settles both the route and where its
 * credential comes from, in which case there is nothing to look up. The one source of
 * truth for that question, so `resolveAuth` and `gatherSignals` cannot drift apart.
 */
export function needsProbes(env: Env, requested: Route | null): boolean {
  if (requested === "gateway" || requested === "own-licence") {
    return false;
  }
  return !hasValue(env.AWS_BEARER_TOKEN_BEDROCK);
}

/**
 * Membership decides more than the wording of a failure now: it is what puts a member on
 * the gateway and what stops anyone reaching their own subscription unawares, so it is
 * resolved whenever it could change the answer. That includes HAI_ROUTE=own-licence, which
 * a member is refused, and an exported CLAUDE_CODE_OAUTH_TOKEN, which no longer settles
 * anything on its own.
 */
export function needsMembership(env: Env, requested: Route | null): boolean {
  if (requested === "own-licence") {
    return true;
  }
  if (requested !== null) {
    return false;
  }
  return !hasValue(env.AWS_BEARER_TOKEN_BEDROCK);
}

/**
 * The I/O half of route resolution, kept apart from `resolveRoute` so the precedence
 * table stays pure. Each probe is skipped only when a higher-precedence signal has already
 * settled both the route and where its credential comes from.
 */
export async function gatherSignals(deps: { seams: Seams; agentHub: AgentHub; offline: boolean; cachedGroupMembership: boolean | null }): Promise<Signals> {
  const { seams, offline } = deps;
  const base: Signals = {
    requestedRoute: requestedRoute(seams.env),
    hasBedrockEnvKey: hasValue(seams.env.AWS_BEARER_TOKEN_BEDROCK),
    hasOauthEnvToken: hasValue(seams.env.CLAUDE_CODE_OAUTH_TOKEN),
    hasStoredBedrockKey: false,
    hasHostClaudeCredential: false,
    isBedrockGroupMember: deps.cachedGroupMembership
  };

  const probing = needsProbes(seams.env, base.requestedRoute);
  const checkingGroup = base.isBedrockGroupMember === null && needsMembership(seams.env, base.requestedRoute);
  if (!(probing || checkingGroup)) {
    return base;
  }

  if (offline) {
    seams.logger.verbose("HAI_OFFLINE=1, so agent-hub and Graph are not consulted");
    return base;
  }

  if (probing) {
    base.hasStoredBedrockKey = await storedBedrockKeyPresent(deps.agentHub, seams);
    if (base.hasStoredBedrockKey) {
      // A stored key settles the route on Bedrock whatever the group answer turns out to
      // be, and it cannot lead anywhere personal, so there is nothing left to ask.
      return base;
    }
  }

  if (checkingGroup) {
    base.isBedrockGroupMember = await checkBedrockGroupMembership(seams);
  }

  // Only read when nobody has confirmed membership: a member is never routed to their own
  // licence, so for them the answer could not change anything.
  if (probing && base.requestedRoute === null && base.isBedrockGroupMember !== true) {
    base.hasHostClaudeCredential = await hasHostClaudeCredential(seams);
  }
  return base;
}

/** A hub that cannot be reached is not evidence of "no key": the key fetch retries and can still prompt. */
async function storedBedrockKeyPresent(agentHub: AgentHub, seams: Seams): Promise<boolean> {
  try {
    return (await agentHub.getBedrockKey()) !== null;
  } catch (err) {
    seams.logger.verbose(`could not ask agent-hub for a stored Bedrock key: ${messageOf(err)}`);
    return false;
  }
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
