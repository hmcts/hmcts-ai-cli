import { messageOf } from "../log/error-message.js";
import type { Seams } from "../system/seams.js";
import type { AgentHub } from "./agent-hub.js";

/**
 * The `agent-hub` route's one credential: the hub's `claude` kind, which is the long-lived
 * token `claude setup-token` mints and which cft-workspace's virtual-agent entrypoint
 * exports as `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * One source and no fallbacks, so every way of not having it fails naming the hub. That
 * includes the hub refusing an owner outright: `OWNER_READABLE` is
 * `["bedrock", "claude_md", "git_identity"]`, so today only a virtual agent with a launch
 * token can read this kind and an owner gets a 403. Failing here is the point — the
 * alternative is handing `claude` a session with no credential injected, which quietly
 * falls back to whatever login happens to be on the machine.
 */
export async function resolveHubClaudeToken(deps: { seams: Seams; agentHub: AgentHub; offline: boolean }): Promise<string> {
  const { seams, agentHub } = deps;
  if (deps.offline) {
    throw new Error(
      `HAI_ROUTE=agent-hub needs ${agentHub.baseUrl}, which HAI_OFFLINE=1 does not consult. Drop HAI_OFFLINE, or pick a route whose credential is on this machine.`
    );
  }

  let token: string | null;
  try {
    token = await agentHub.getCredential("claude");
  } catch (err) {
    throw new Error(
      `HAI_ROUTE=agent-hub, but ${agentHub.baseUrl} would not give up your Claude token (${messageOf(err)}). The hub serves its claude kind to a virtual agent rather than to you, so this route needs the hub widened first.`
    );
  }
  if (token === null) {
    throw new Error(
      `HAI_ROUTE=agent-hub, but ${agentHub.baseUrl} holds no Claude token for you. Sign a virtual agent in to Claude on the agent-hub virtual agents page, or pick another route.`
    );
  }
  seams.logger.verbose(`agent-hub supplied the Claude token it holds for you (${agentHub.baseUrl})`);
  return token;
}
