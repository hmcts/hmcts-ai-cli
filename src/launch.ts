import { type AgentHub, createAgentHub } from "./auth/agent-hub.js";
import { resolveBedrockKey } from "./auth/bedrock-key.js";
import { buildClaudeEnv } from "./auth/claude-env.js";
import { type Gateway, prepareGateway } from "./auth/gateway.js";
import { resolveAuth } from "./auth/resolve-auth.js";
import type { RouteResolution } from "./auth/route.js";
import { buildClaudeArgs, forwardArgv } from "./claude/args.js";
import { buildSettings, materialiseSettings } from "./claude/settings.js";
import { extractUserSettings, mergeSettings, readUserSettings } from "./claude/user-settings.js";
import { runContainerMode } from "./container/run.js";
import { describeEnv } from "./log/redact.js";
import { containerReasons, isInContainer, probeContainer } from "./system/container.js";
import { asProcessEnv, isEnabled } from "./system/env.js";
import type { Seams } from "./system/seams.js";
import { maybeSelfUpdate, readCurrentVersion } from "./update/self-update.js";
import { parsePluginNames, resolvePluginDirs } from "./workspace/plugin-dirs.js";
import { findWorkspaceRoot } from "./workspace/workspace-root.js";

export async function launch(deps: { seams: Seams; processArgv: string[] }): Promise<void> {
  const { seams } = deps;
  const forwarded = forwardArgv(deps.processArgv);

  const probe = await probeContainer(seams);
  const contained = isInContainer(probe);
  seams.logger.verbose(contained ? `already containerised: ${containerReasons(probe).join("; ")}` : `${hostReason(probe)}, so hai starts the container itself`);

  // Re-exec with the argv as typed, so the new release makes its own decisions about it.
  if (await updatedAndReExeced(deps, forwarded)) {
    return;
  }

  // A nested hai inside an environment we already built has nothing to resolve, and
  // paying for an agent-hub round trip per nesting level adds up fast.
  const envReady = isEnabled(seams.env, "HAI_IN_CONTAINER") && isEnabled(seams.env, "HAI_ENV_READY");
  if (envReady) {
    seams.logger.verbose("HAI_IN_CONTAINER=1 and HAI_ENV_READY=1, so the route is already resolved");
  }

  // One client, so the az token behind it is fetched once however many times it is used.
  const agentHub = createAgentHub(seams);
  const resolution = envReady ? null : await resolveAuth({ seams, agentHub });
  const credentials = resolution === null ? {} : await collectCredentials({ seams, agentHub }, resolution);
  const added = resolution === null ? {} : buildClaudeEnv({ env: seams.env, route: resolution.route, ...credentials });
  if (resolution !== null) {
    seams.logger.verbose(`route ${resolution.route} via ${resolution.credentialSource}: ${resolution.reasons.join("; ")}`);
  }

  const root = await findWorkspaceRoot(seams);
  const pluginDirs = root === null ? [] : await resolvePluginDirs({ ...seams, root, names: parsePluginNames(seams.env.AGENT_HUB_PLUGINS) });

  if (!contained) {
    return await runContainerMode({
      seams,
      forwarded,
      added,
      hasGateway: credentials.gateway !== undefined,
      workspaceRoot: root,
      pluginDirs
    });
  }

  const user = extractUserSettings(forwarded);
  const ours = buildSettings({ inWorkspace: root !== null, apiKeyHelperPath: credentials.gateway?.helperPath });
  const merged = mergeSettings(ours, user.value === undefined ? {} : await readUserSettings(seams, user.value));
  for (const warning of merged.warnings) {
    seams.logger.say(warning);
  }
  const argv = buildClaudeArgs({
    settings: await materialiseSettings(seams, merged.settings, credentials.gateway !== undefined),
    skipPermissions: root !== null && seams.env.HAI_PERMISSIONS !== "ask",
    pluginDirs,
    userArgs: user.argv
  });

  // No markers here: this exec replaces the process in place, so HAI_ENV_READY would be
  // inherited by every shell in the session and short-circuit each nested hai past the
  // update check for good. Only a container hai starts gets them (src/container/run.ts).
  const env = { ...asProcessEnv(seams.env), ...added };

  if (isEnabled(seams.env, "HAI_DRY_RUN")) {
    seams.stdout(`${argv.join(" ")}\n`);
    for (const line of describeEnv(added)) {
      seams.stdout(`  ${line}\n`);
    }
    seams.exit(0);
  }

  await seams.runner.exec(argv, { env });
}

function hostReason(probe: { forcedHost: boolean }): string {
  return probe.forcedHost ? "HAI_FORCE_HOST=1" : "no container signals";
}

async function collectCredentials(
  deps: { seams: Seams; agentHub: AgentHub },
  resolution: RouteResolution
): Promise<{ bedrockKey?: string; gateway?: Gateway }> {
  const { seams } = deps;
  if (resolution.route === "gateway") {
    return { gateway: await prepareGateway({ seams }) };
  }
  if (resolution.route === "bedrock") {
    return { bedrockKey: await resolveBedrockKey({ seams, agentHub: deps.agentHub, offline: isEnabled(seams.env, "HAI_OFFLINE") }) };
  }
  return {};
}

/** Re-exec rather than carry on in-process, so the new release is the one that runs. */
export async function updatedAndReExeced(deps: { seams: Seams }, userArgs: string[]): Promise<boolean> {
  const { seams } = deps;
  const outcome = await maybeSelfUpdate({ seams, currentVersion: await readCurrentVersion(seams) });
  if (!outcome.reExec) {
    return false;
  }
  await seams.runner.exec([seams.execPath, seams.scriptPath, ...userArgs], { env: { ...asProcessEnv(seams.env), HAI_UPDATED: "1" } });
  return true;
}
