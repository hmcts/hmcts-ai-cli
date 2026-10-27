import { checkBedrockGroupMembership } from "../az/group-membership.js";
import { messageOf } from "../log/error-message.js";
import type { Env } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";
import { hasHostClaudeCredential } from "./claude-credentials.js";
import { badRouteMessage, isRoute, type Route, type Signals } from "./route.js";

export function requestedRoute(env: Env): Route | null {
  const requested = env.HAI_ROUTE;
  if (requested === undefined || requested === "") {
    return null;
  }
  if (!isRoute(requested)) {
    throw new Error(badRouteMessage(requested));
  }
  return requested;
}

/**
 * False when nothing a probe could find would change the answer. An explicit route names
 * one credential and one source, so every signal here is about the *unset* path: hai goes
 * and gets that one credential when the time comes rather than hunting for evidence of it
 * first. The one source of truth for the question, so `resolveAuth` and `gatherSignals`
 * cannot drift apart.
 */
export function needsProbes(env: Env, requested: Route | null): boolean {
  if (requested !== null) {
    return false;
  }
  return !hasValue(env.AWS_BEARER_TOKEN_BEDROCK);
}

/**
 * Membership is what puts a member on the AI Gateway and what stops the unset path
 * reaching a personal subscription unawares. An explicit `HAI_ROUTE` resolves none at all,
 * which drops an `az account show` and an `az rest checkMemberGroups` from every run that
 * names its route. Wider than `needsProbes`: membership is the first branch of the unset
 * path, so a key in the environment does not settle it.
 */
export function needsMembership(_env: Env, requested: Route | null): boolean {
  return requested === null;
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

  // Asked first because it is the first branch of the precedence table: a member goes to
  // the gateway whatever keys exist, so nothing below can change the answer.
  if (checkingGroup && !offline) {
    base.isBedrockGroupMember = await checkBedrockGroupMembership(seams);
    askedGraph = true;
  }
  if (base.isBedrockGroupMember === true) {
    return { signals: base, askedGraph };
  }

  if (probing && !offline) {
    base.hasStoredBedrockKey = await storedBedrockKeyPresent(deps.agentHub, seams);
    if (base.hasStoredBedrockKey) {
      return { signals: base, askedGraph };
    }
  }

  if (probing) {
    base.hasHostClaudeCredential = await hasHostClaudeCredential(seams);
  }
  return { signals: base, askedGraph };
}

/**
 * A hub that cannot be reached is not evidence of "no key": it decides nothing and is not
 * fatal, the remaining signals choose the route, and `resolveBedrockKey` asks the hub again
 * on any unset-path route that ends at bedrock. That retry is the point — a 5xx or this
 * probe's 15s timeout must not turn into "paste a key the hub already holds".
 */
async function storedBedrockKeyPresent(agentHub: AgentHub, seams: Seams): Promise<boolean> {
  try {
    return (await agentHub.getCredential("bedrock")) !== null;
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
