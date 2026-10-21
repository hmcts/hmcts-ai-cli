import { accountCacheKey, readAzAccount } from "../az/account.js";
import { isEnabled } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";
import { type AuthCacheEntry, readAuthCache, writeAuthCache } from "./auth-cache.js";
import { REMEDIES, type RouteResolution, resolveRoute } from "./route.js";
import { gatherSignals, needsProbes, requestedRoute } from "./signals.js";

const NO_IDENTITY_KEY = "anonymous";

/**
 * Resolves a route, consulting and refreshing the on-disk cache. The cache only ever
 * holds a route decision and a group-membership answer; credentials are never cached.
 */
export async function resolveAuth(deps: { seams: Seams; agentHub: AgentHub }): Promise<RouteResolution> {
  const { seams } = deps;
  const offline = isEnabled(seams.env, "HAI_OFFLINE");
  const requested = requestedRoute(seams.env);

  // Nothing to look up means nothing to cache, so neither the identity call nor the
  // cache read is worth making.
  const probing = needsProbes(seams.env, requested);
  const account = offline || !probing ? null : await readAzAccount(seams);
  const key = account === null ? NO_IDENTITY_KEY : accountCacheKey(account);
  const cached = probing ? await readAuthCache(seams, key) : null;

  if (offline && requested === null && cached?.route !== undefined && !hasEnvCredential(seams)) {
    seams.logger.verbose(`HAI_OFFLINE=1, using the cached ${cached.route.route} route`);
    return { route: cached.route.route, credentialSource: cached.route.credentialSource, reasons: [...cached.route.reasons, "from the 12h route cache"] };
  }

  const signals = await gatherSignals({ seams, agentHub: deps.agentHub, offline, cachedGroupMembership: cached?.group?.isMember ?? null });
  const resolution = resolveRoute(signals);

  if (resolution.credentialSource === "unavailable") {
    throw new Error(`${resolution.reasons.join("; ")}. Pick one of:\n  - ${REMEDIES.join("\n  - ")}`);
  }

  if (probing) {
    await persist(deps, key, resolution, signals.isBedrockGroupMember);
  }
  return resolution;
}

function hasEnvCredential(seams: Seams): boolean {
  return (seams.env.AWS_BEARER_TOKEN_BEDROCK ?? "") !== "" || (seams.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "";
}

async function persist(deps: { seams: Seams }, key: string, resolution: RouteResolution, isMember: boolean | null): Promise<void> {
  const at = deps.seams.clock.now();
  const entry: AuthCacheEntry = { route: { at, ...resolution } };
  if (isMember !== null) {
    entry.group = { at, isMember };
  }
  try {
    await writeAuthCache(deps.seams, key, entry);
  } catch {
    // A read-only or missing state dir costs a round trip next time, nothing more.
    deps.seams.logger.verbose("could not write the route cache");
  }
}
