import { type AgentHub, createAgentHub } from "./auth/agent-hub.js";
import { resolveBedrockKey } from "./auth/bedrock-key.js";
import { buildClaudeEnv, conflictingEnv } from "./auth/claude-env.js";
import { resolveHubClaudeToken } from "./auth/claude-token.js";
import type { Gateway } from "./auth/gateway.js";
import { type AuthResolution, resolveAuth } from "./auth/resolve-auth.js";
import { billingNote } from "./auth/route.js";
import { buildClaudeArgs, forwardArgv } from "./claude/args.js";
import { sessionRegistryHooks } from "./claude/hooks.js";
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
  const auth = envReady ? null : await resolveAuth({ seams, agentHub });
  if (auth !== null) {
    const { route, credentialSource, reasons } = auth.resolution;
    // Unconditional, and before the credential is fetched so it is also the answer to "why
    // am I being asked to paste a key": two routes bill a personal Claude licence and two
    // bill HMCTS, and the name does not say which.
    seams.logger.say(billingNote(route));
    seams.logger.verbose(`${route} via ${credentialSource}: ${reasons.join("; ")}`);
  }
  const credentials = auth === null ? {} : await collectCredentials({ seams, agentHub }, auth);
  const added = auth === null ? {} : buildClaudeEnv({ env: seams.env, route: auth.resolution.route, ...credentials });
  // Not setting a variable is not the same as removing one: the handover below is the
  // process environment with `added` over it, so another payer's credential or switch
  // would survive and the line just printed would be a lie.
  const removed = auth === null ? [] : conflictingEnv(auth.resolution.route);

  const root = await findWorkspaceRoot(seams);
  const pluginDirs = root === null ? [] : await resolvePluginDirs({ ...seams, root, names: parsePluginNames(seams.env.AGENT_HUB_PLUGINS) });

  if (!contained) {
    return await runContainerMode({
      seams,
      forwarded,
      added,
      removed,
      hasGateway: credentials.gateway !== undefined,
      workspaceRoot: root,
      pluginDirs
    });
  }

  const user = extractUserSettings(forwarded);
  const ours = buildSettings({
    inWorkspace: root !== null,
    apiKeyHelperPath: credentials.gateway?.helperPath,
    hooks: sessionRegistryHooks(seams, { forwarded, forContainer: false })
  });
  const merged = mergeSettings(ours, user.value === undefined ? {} : await readUserSettings(seams, user.value));
  for (const warning of merged.warnings) {
    seams.logger.say(warning);
  }
  const argv = buildClaudeArgs({
    settings: await materialiseSettings(seams, merged.settings, credentials.gateway !== undefined),
    pluginDirs,
    userArgs: user.argv
  });

  // No markers here: this exec replaces the process in place, so HAI_ENV_READY would be
  // inherited by every shell in the session and short-circuit each nested hai past the
  // update check for good. Only a container hai starts gets them (src/container/run.ts).
  const env = { ...asProcessEnv(seams.env), ...added };
  const cleared = removed.filter((name) => name in env);
  for (const name of cleared) {
    delete env[name];
  }
  if (cleared.length > 0) {
    seams.logger.verbose(`cleared ${cleared.join(", ")}, which belong to another route`);
  }

  if (isEnabled(seams.env, "HAI_DRY_RUN")) {
    seams.stdout(`${argv.join(" ")}\n`);
    for (const line of describeEnv(added)) {
      seams.stdout(`  ${line}\n`);
    }
    if (cleared.length > 0) {
      seams.stdout(`  cleared: ${cleared.join(", ")}\n`);
    }
    seams.exit(0);
  }

  await seams.runner.exec(argv, { env });
}

function hostReason(probe: { forcedHost: boolean }): string {
  return probe.forcedHost ? "HAI_FORCE_HOST=1" : "no container signals";
}

/** The gateway's key is settled by `resolveAuth`, because whether it can be read at all is part of the route decision. */
async function collectCredentials(deps: { seams: Seams; agentHub: AgentHub }, auth: AuthResolution): Promise<Credentials> {
  const { seams } = deps;
  const offline = isEnabled(seams.env, "HAI_OFFLINE");
  if (auth.resolution.route === "ai-gateway") {
    return { gateway: auth.gateway };
  }
  if (auth.resolution.route === "bedrock") {
    // byName decides how far it may look: a named HAI_ROUTE=bedrock reads the environment
    // or prompts, the unset path keeps env → agent-hub → prompt.
    return { bedrockKey: await resolveBedrockKey({ seams, agentHub: deps.agentHub, offline, byName: auth.resolution.byName }) };
  }
  if (auth.resolution.route === "agent-hub") {
    return { claudeToken: await resolveHubClaudeToken({ seams, agentHub: deps.agentHub, offline }) };
  }
  // byol: the credential is already where claude looks for it, so there is nothing to fetch.
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

interface Credentials {
  bedrockKey?: string;
  claudeToken?: string;
  gateway?: Gateway;
}
