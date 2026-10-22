import { createAgentHub } from "./auth/agent-hub.js";
import { resolveAuth } from "./auth/resolve-auth.js";
import { forwardArgv } from "./claude/args.js";
import { updatedAndReExeced } from "./launch.js";
import { messageOf } from "./log/error-message.js";
import { runSbxMode } from "./sbx/run.js";
import { containerReasons, isInContainer, probeContainer } from "./system/container.js";
import type { Seams } from "./system/seams.js";
import { findWorkspaceRoot } from "./workspace/workspace-root.js";

/**
 * `sbx-hai`: the same contract as `hai` — every argument forwarded to `claude` verbatim,
 * the same self-update, the route resolved on the host — with the session running in a
 * Docker Sandboxes microVM instead of a container hai starts itself.
 *
 * The claude argv is *not* built here, unlike the other two backends: the kit's own launch
 * script decides between `claude --dangerously-skip-permissions` and `.claude/run.sh`
 * depending on which credential sbx bound, so hai forwards the arguments and nothing else.
 */
export async function launchSbx(deps: { seams: Seams; processArgv: string[] }): Promise<void> {
  const { seams } = deps;
  const forwarded = forwardArgv(deps.processArgv);

  // sbx talks to a daemon on the host and starts a microVM there; there is nothing for it
  // to talk to from inside a container. HAI_FORCE_HOST=1 is the way to exercise this path
  // from a devcontainer, as it is for container mode.
  const probe = await probeContainer(seams);
  if (isInContainer(probe)) {
    throw new Error(`sbx-hai runs on the host, not inside a container (${containerReasons(probe).join("; ")}). Docker Sandboxes is a host-only tool.`);
  }

  if (await updatedAndReExeced(deps, forwarded)) {
    return;
  }

  seams.logger.verbose(await routeNote(deps));
  const root = await findWorkspaceRoot(seams);
  await runSbxMode({ seams, forwarded, workspaceRoot: root });
}

/**
 * Informational only. The route decides nothing here — the sandbox has its own credential
 * — and a host with no usable one must still be able to start a sandbox, so a resolution
 * that fails is reported rather than fatal.
 */
async function routeNote(deps: { seams: Seams }): Promise<string> {
  try {
    const { resolution } = await resolveAuth({ seams: deps.seams, agentHub: createAgentHub(deps.seams) });
    return `route ${resolution.route} via ${resolution.credentialSource} would apply on this host`;
  } catch (err) {
    return `no route resolves on this host, which does not stop the sandbox: ${messageOf(err)}`;
  }
}
