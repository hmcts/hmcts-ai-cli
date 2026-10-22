import { accountCacheKey, readAzAccount } from "../az/account.js";
import { isEnabled } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";
import { readAuthCache, writeAuthCache } from "./auth-cache.js";
import { REMEDIES, type RouteResolution, resolveRoute } from "./route.js";
import { gatherSignals, needsProbes, requestedRoute } from "./signals.js";

/**
 * Resolves a route, consulting and refreshing the on-disk cache. The cache only ever
 * holds a group-membership answer, which saves one `az rest checkMemberGroups`;
 * credentials are never cached.
 */
export async function resolveAuth(deps: { seams: Seams; agentHub: AgentHub }): Promise<RouteResolution> {
  const { seams } = deps;
  const offline = isEnabled(seams.env, "HAI_OFFLINE");
  const requested = requestedRoute(seams.env);

  // Nothing to look up means nothing to cache, so neither the identity call nor the cache
  // read is worth making. Offline skips both: the cache is keyed by the signed-in
  // identity, and asking az for that is itself a call out.
  const probing = needsProbes(seams.env, requested);
  const account = offline || !probing ? null : await readAzAccount(seams);
  const key = account === null ? null : accountCacheKey(account);
  const cached = key === null ? null : await readAuthCache(seams, key);

  const signals = await gatherSignals({ seams, agentHub: deps.agentHub, offline, cachedGroupMembership: cached?.group?.isMember ?? null });
  const resolution = resolveRoute(signals);

  if (resolution.credentialSource === "unavailable") {
    throw new Error(`${resolution.reasons.join("; ")}. Pick one of:\n  - ${REMEDIES.join("\n  - ")}`);
  }

  if (key !== null && signals.isBedrockGroupMember !== null) {
    await persist(deps, key, signals.isBedrockGroupMember);
  }
  return resolution;
}

async function persist(deps: { seams: Seams }, key: string, isMember: boolean): Promise<void> {
  try {
    await writeAuthCache(deps.seams, key, { group: { at: deps.seams.clock.now(), isMember } });
  } catch {
    // A read-only or missing state dir costs a round trip next time, nothing more.
    deps.seams.logger.verbose("could not write the group-membership cache");
  }
}
