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
 * cache only ever holds a group-membership answer, which saves one
 * `az rest checkMemberGroups`; credentials are never cached. It is therefore the default
 * path's cache alone — an explicit `HAI_ROUTE` resolves no membership, so it neither reads
 * nor writes it.
 *
 * `decideOnly` stops at the decision: no VPN probe, no Key Vault read, no `apiKeyHelper`
 * written and nothing said on the terminal. That is what `sbx-hai` wants, where the route
 * is a verbose note and the sandbox binds its own credential — a best-effort note has no
 * business doing the gateway's I/O or warning about a fallback that cannot apply to it.
 * The refusals still stand, so a confirmed member is never reported a personal route.
 */
export async function resolveAuth(deps: { seams: Seams; agentHub: AgentHub; decideOnly?: boolean }): Promise<AuthResolution> {
  const { seams } = deps;
  const offline = isEnabled(seams.env, "HAI_OFFLINE");
  const requested = requestedRoute(seams.env);

  // The cache holds nothing but the group answer, so the identity call that keys it is
  // only worth making when that answer is wanted. It is made offline too: `az account show`
  // reads ~/.azure/azureProfile.json and nothing else, which is why it still answers after
  // the refresh token has expired — so offline derives the same key and a membership
  // confirmed earlier today still applies. Only the Graph call behind it is skipped.
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

  // Only a freshly fetched answer is stamped. Writing a cache hit back would slide the TTL
  // forward on every run, so anyone who runs hai at least daily would be checked against
  // Graph once and never again — and a cached "not a member" would keep billing them.
  if (key !== null && askedGraph && signals.isBedrockGroupMember !== null) {
    await persist(deps, key, signals.isBedrockGroupMember);
  }
  if (resolution.route === "ai-gateway" && deps.decideOnly !== true) {
    return await settleGateway(deps, resolution);
  }
  return { resolution };
}

/**
 * The AI Gateway's APIM key lives in a private Key Vault that needs az and the F5 VPN, so
 * whether the route works at all is I/O rather than a decision. When hai chose the gateway
 * itself and the key cannot be read, the fallback is a Bedrock key pasted by hand and
 * never the engineer's own subscription — that silent fallback is what this order exists
 * to prevent, so every step of it is said out loud. `HAI_ROUTE=ai-gateway` fails outright
 * instead: an explicit route is one credential from one source, and a downgrade would
 * silently move who pays.
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
    // `byName: false`, because hai chose this: the key is resolved the way the unset path
    // resolves one, env → agent-hub → prompt. The two failures are independent — the hub
    // probe can have thrown while the Key Vault failed for a VPN that is down — so a key
    // the hub already holds must still be used rather than asked for and overwritten.
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
