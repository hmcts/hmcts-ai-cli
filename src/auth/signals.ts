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
 *
 * `askedGraph` reports provenance rather than leaving the caller to infer it from the
 * answer: a membership that came out of the cache must not be written back with a fresh
 * timestamp, or the TTL slides forward on every run and the check happens once, ever.
 */
export async function gatherSignals(deps: {
  seams: Seams;
  agentHub: AgentHub;
  offline: boolean;
  cachedGroupMembership: boolean | null;
}): Promise<GatheredSignals> {
  const { seams, offline } = deps;
  const base: Signals = {
    requestedRoute: requestedRoute(seams.env),
    hasBedrockEnvKey: hasValue(seams.env.AWS_BEARER_TOKEN_BEDROCK),
    hasOauthEnvToken: hasValue(seams.env.CLAUDE_CODE_OAUTH_TOKEN),
    hasStoredBedrockKey: false,
    hasHostClaudeCredential: false,
    isBedrockGroupMember: deps.cachedGroupMembership,
    offline
  };
  let askedGraph = false;

  const probing = needsProbes(seams.env, base.requestedRoute);
  const checkingGroup = base.isBedrockGroupMember === null && needsMembership(seams.env, base.requestedRoute);
  if (!(probing || checkingGroup)) {
    return { signals: base, askedGraph };
  }

  // Offline stops the two probes that go out over the network. What is on this machine is
  // still read: the group answer the cache already holds decides as much offline as it does
  // online, and a claude.ai login is a file in ~/.claude.
  if (offline) {
    seams.logger.verbose("HAI_OFFLINE=1, so agent-hub and Graph are not consulted");
  }

  if (probing && !offline) {
    base.hasStoredBedrockKey = await storedBedrockKeyPresent(deps.agentHub, seams);
    if (base.hasStoredBedrockKey) {
      // A stored key settles the route on Bedrock whatever the group answer turns out to
      // be, and it cannot lead anywhere personal, so there is nothing left to ask.
      return { signals: base, askedGraph };
    }
  }

  if (checkingGroup && !offline) {
    base.isBedrockGroupMember = await checkBedrockGroupMembership(seams);
    askedGraph = true;
  }

  // Only read when nobody has confirmed membership: a member is never routed to their own
  // licence, so for them the answer could not change anything.
  if (probing && base.requestedRoute === null && base.isBedrockGroupMember !== true) {
    base.hasHostClaudeCredential = await hasHostClaudeCredential(seams);
  }
  return { signals: base, askedGraph };
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

export interface GatheredSignals {
  signals: Signals;
  /** True only when this run made the `az rest checkMemberGroups` call itself. */
  askedGraph: boolean;
}
