import { accountCacheKey, readAzAccount } from "../az/account.js";
import { messageOf } from "../log/error-message.js";
import { isEnabled } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";
import { readAuthCache, writeAuthCache } from "./auth-cache.js";
import { canPrompt } from "./bedrock-key.js";
import { type Gateway, prepareGateway } from "./gateway.js";
import { REMEDIES, type RouteResolution, resolveRoute } from "./route.js";
import { gatherSignals, needsMembership, requestedRoute } from "./signals.js";

/**
 * Resolves a route, consulting and refreshing the on-disk cache, and settles the one
 * question `resolveRoute` cannot answer on its own: whether the AI Gateway is usable. The
 * cache holds only a group-membership answer; credentials are never cached. `decideOnly`
 * stops at the decision: no VPN probe, no Key Vault read, no `apiKeyHelper` written and
 * nothing said on the terminal.
 */
export async function resolveAuth(deps: { seams: Seams; agentHub: AgentHub; decideOnly?: boolean }): Promise<AuthResolution> {
  const { seams } = deps;
  const offline = isEnabled(seams.env, "HAI_OFFLINE");
  const requested = requestedRoute(seams.env);

  // `az account show` reads ~/.azure/azureProfile.json, so it still answers after the
  // refresh token has expired and derives the same cache key offline; only the Graph call
  // behind it is skipped.
  const wantsGroup = needsMembership(seams.env, requested);
  const account = wantsGroup ? await readAzAccount(seams) : null;
  const key = account === null ? null : accountCacheKey(account);
  const cached = key === null ? null : await readAuthCache(seams, key);

  const { signals, askedGraph } = await gatherSignals({ seams, agentHub: deps.agentHub, offline, cachedGroupMembership: cached?.group?.isMember ?? null });
  const resolution = resolveRoute(signals);

  if (resolution.credentialSource === "unavailable") {
    throw new Error(`${resolution.reasons.join("; ")}. Pick one of:\n  - ${REMEDIES.join("\n  - ")}`);
  }
  if (resolution.credentialSource === "refused") {
    throw new Error(resolution.reasons.join("; "));
  }

  // Only a freshly fetched answer is stamped: writing a cache hit back would slide the TTL
  // forward on every run, so it would never expire.
  if (key !== null && askedGraph && signals.isBedrockGroupMember !== null) {
    await persist(deps, key, signals.isBedrockGroupMember);
  }
  if (resolution.route === "ai-gateway" && deps.decideOnly !== true) {
    return await settleGateway(deps, resolution);
  }
  return { resolution };
}

/**
 * Whether the AI Gateway works is I/O rather than a decision — its APIM key is in a
 * private Key Vault that needs az and the F5 VPN. A named `HAI_ROUTE=ai-gateway` fails
 * outright rather than downgrading, because a downgrade would move who pays.
 */
async function settleGateway(deps: { seams: Seams }, resolution: RouteResolution): Promise<AuthResolution> {
  const { seams } = deps;
  try {
    return { resolution, gateway: await prepareGateway({ seams }) };
  } catch (err) {
    if (resolution.byName) {
      throw err;
    }
    const why = `the AI Gateway was chosen but its APIM key could not be read (${messageOf(err)})`;
    if (!canPrompt(seams)) {
      throw new Error(
        `${why}, and stdin is not a terminal so there is nobody to paste an Amazon Bedrock API key. hai will not use a personal claude.ai subscription instead. Connect the F5 VPN and run az login, or export AWS_BEARER_TOKEN_BEDROCK.`
      );
    }
    seams.logger.say(`${why}; falling back to an Amazon Bedrock API key — hai will not use your personal claude.ai subscription`);
    // `byName: false`, so the key is resolved the way the unset path resolves one: the hub
    // may still hold one when the Key Vault read failed, the two being independent.
    return { resolution: { route: "bedrock", credentialSource: "prompt", reasons: [...resolution.reasons, why], byName: false } };
  }
}

async function persist(deps: { seams: Seams }, key: string, isMember: boolean): Promise<void> {
  try {
    await writeAuthCache(deps.seams, key, { group: { at: deps.seams.clock.now(), isMember } });
  } catch {
    // A read-only or missing state dir costs a round trip next time, nothing more.
    deps.seams.logger.verbose("could not write the group-membership cache");
  }
}

export interface AuthResolution {
  resolution: RouteResolution;
  /** Prepared here rather than by the caller, because whether it can be is part of the decision. */
  gateway?: Gateway;
}
