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
 * `sbx-hai`: the same contract as `hai`, with the session in a Docker Sandboxes microVM. The claude
 * argv is not built here — the kit's own launch script execs `hai` with the arguments after the `--`.
 */
export async function launchSbx(deps: { seams: Seams; processArgv: string[] }): Promise<void> {
  const { seams } = deps;
  const forwarded = forwardArgv(deps.processArgv);

  // sbx talks to a daemon on the host, so there is nothing for it to reach from inside a container.
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
 * Informational only: the sandbox has its own credential, so a resolution that fails is reported
 * rather than fatal. `decideOnly` keeps it to a decision — no VPN probe and no Key Vault read.
 */
async function routeNote(deps: { seams: Seams }): Promise<string> {
  try {
    const { resolution } = await resolveAuth({ seams: deps.seams, agentHub: createAgentHub(deps.seams), decideOnly: true });
    return `route ${resolution.route} via ${resolution.credentialSource} would apply on this host`;
  } catch (err) {
    return `no route resolves on this host, which does not stop the sandbox: ${messageOf(err)}`;
  }
}
