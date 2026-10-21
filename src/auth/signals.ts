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
 * credential comes from, in which case there is nothing to look up and nothing worth
 * caching. The one source of truth for that question, so `resolveAuth` and
 * `gatherSignals` cannot drift apart.
 */
export function needsProbes(env: Env, requested: Route | null): boolean {
  if (requested === "gateway" || requested === "own-licence") {
    return false;
  }
  if (hasValue(env.AWS_BEARER_TOKEN_BEDROCK)) {
    return false;
  }
  return !(requested === null && hasValue(env.CLAUDE_CODE_OAUTH_TOKEN));
}

/**
 * The I/O half of route resolution, kept apart from `resolveRoute` so the precedence
 * table stays pure. Each probe is skipped as soon as a higher-precedence signal has
 * already settled both the route and where its credential comes from.
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

  if (!needsProbes(seams.env, base.requestedRoute)) {
    return base;
  }

  if (offline) {
    seams.logger.verbose("HAI_OFFLINE=1, so agent-hub and Graph are not consulted");
    return base;
  }

  base.hasStoredBedrockKey = await storedBedrockKeyPresent(deps.agentHub, seams);
  if (base.hasStoredBedrockKey) {
    return base;
  }

  if (base.requestedRoute === null) {
    base.hasHostClaudeCredential = await hasHostClaudeCredential(seams);
    if (base.hasHostClaudeCredential) {
      return base;
    }
  }

  if (base.isBedrockGroupMember === null) {
    base.isBedrockGroupMember = await checkBedrockGroupMembership(seams);
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
