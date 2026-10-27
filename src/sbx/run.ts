import { join } from "node:path";
import { acrPullToken, REGISTRY_HOST } from "../container/acr.js";
import { sessionName } from "../container/session.js";
import { isEnabled } from "../system/env.js";
import type { Seams } from "../system/seams.js";
import {
  ALLOWED_SOURCES_KEY,
  allowedSourcesDecision,
  DOCKER_VOLUME_KEY,
  daemonMismatch,
  KIT_IMAGE,
  KIT_REGISTRY,
  KIT_REPOSITORY,
  kitComparable,
  kitStaleness,
  parseIndexDigests,
  parseKitRecord,
  parseSandboxNames,
  parseSbxVersion,
  staleKitMessage,
  volumeSizeDecision
} from "./kit.js";
import {
  buildAllowedSourcesSetArgs,
  buildCreateArgs,
  buildDockerVolumeSetArgs,
  buildInspectArgs,
  buildKitDigestArgs,
  buildKitIndexArgs,
  buildListArgs,
  buildReattachArgs,
  buildSecretSetArgs,
  buildSettingsGetArgs,
  buildVersionArgs,
  type SbxContext,
  SECRET_SCOPES
} from "./sbx-args.js";

const SBX_TIMEOUT_MS = 60_000;
const AZ_TIMEOUT_MS = 60_000;
/** The Runner's code for a binary it could not spawn at all. */
const SPAWN_FAILED = 127;

const NOT_INSTALLED = "sbx is not installed, so there is no Docker Sandboxes to run in. Install it: https://docs.docker.com/ai/sandboxes/install/";

const CREDENTIAL_NOTE =
  "the sandbox signs in with its own sbx-stored credential (scripts/sbx-setup stores one), so no credential and no route environment is forwarded into it";

/**
 * Docker Sandboxes mode: the session runs in an sbx microVM built from the published
 * cft-workspace kit. sbx injects the Anthropic credential itself from its own secret store.
 */
export async function runSbxMode(input: { seams: Seams; forwarded: string[]; workspaceRoot: string | null }): Promise<void> {
  const { seams } = input;
  const ctx = await gatherContext(input);

  if (isEnabled(seams.env, "HAI_DRY_RUN")) {
    seams.stdout(`${buildCreateArgs(ctx).join(" ")}\n`);
    seams.stdout(`${buildReattachArgs(ctx).join(" ")}\n`);
    seams.stdout(`  the first creates sandbox ${ctx.name}; the second is what a later run does instead, reattaching to the one that exists\n`);
    seams.stdout(`  ${CREDENTIAL_NOTE}\n`);
    seams.exit(0);
  }

  await requireSbxDaemon(seams);
  seams.logger.say(CREDENTIAL_NOTE);

  const existing = (await sandboxNames(seams)).includes(ctx.name);
  if (existing) {
    await warnIfKitStale(seams, ctx.name);
    seams.logger.verbose(`reattaching to sandbox ${ctx.name}, which keeps the kit, workspaces and environment in its own spec`);
    seams.exit(await seams.runner.interactive(buildReattachArgs(ctx)));
  }

  await allowKitSource(seams);
  await raiseDockerVolume(seams);
  // Only the create pulls, so only the create needs a fresh token.
  await refreshRegistrySecret(seams);
  await prepareHost(seams, ctx);
  seams.logger.say(`creating sandbox ${ctx.name} from ${ctx.kit}`);
  seams.exit(await seams.runner.interactive(buildCreateArgs(ctx)));
}

async function gatherContext(input: { seams: Seams; forwarded: string[]; workspaceRoot: string | null }): Promise<SbxContext & { historyDir: string }> {
  const { seams } = input;
  const home = seams.env.HOME;
  if (home === undefined || home === "") {
    throw new Error("HOME is not set, so there is no way to work out which conversation history to share with the sandbox");
  }
  const workspace = input.workspaceRoot ?? (await gitToplevel(seams));
  const name = sessionName({ repoPath: workspace, requested: seams.env.HAI_SESSION });
  // Shared with the host, so conversations outlive the sandbox; there is no transcript lock.
  const historyDir = join(home, ".claude", "projects");
  return {
    name,
    kit: KIT_IMAGE,
    workspaces: [workspace, historyDir],
    env: { ...(await gitIdentity(seams, workspace)), CFT_HOST_CLAUDE_PROJECTS: historyDir },
    claudeArgs: input.forwarded,
    historyDir
  };
}

/**
 * `sbx version --json` answers without the version gate, so it is both the "is sbx here" probe
 * and the mismatch probe. The Runner closes stdin, so an unexpected prompt cannot hang.
 */
async function requireSbxDaemon(seams: Seams): Promise<void> {
  const result = await seams.runner.run(buildVersionArgs(), { timeoutMs: SBX_TIMEOUT_MS });
  if (result.code === SPAWN_FAILED && result.stderr.includes("ENOENT")) {
    throw new Error(NOT_INSTALLED);
  }
  const mismatch = daemonMismatch(parseSbxVersion(result.stdout));
  if (mismatch !== null) {
    throw new Error(mismatch);
  }
}

async function sandboxNames(seams: Seams): Promise<string[]> {
  const result = await seams.runner.run(buildListArgs(), { timeoutMs: SBX_TIMEOUT_MS });
  return result.code === 0 ? parseSandboxNames(result.stdout) : [];
}

/** Best effort throughout: nothing here may stop a reattach, so what cannot tell says nothing. */
async function warnIfKitStale(seams: Seams, name: string): Promise<void> {
  const inspected = await seams.runner.run(buildInspectArgs(name), { timeoutMs: SBX_TIMEOUT_MS });
  const record = inspected.code === 0 ? parseKitRecord(inspected.stdout) : null;
  const comparable = kitComparable(record);
  if (!comparable.yes) {
    seams.logger.verbose(`not checking whether the kit is stale: ${comparable.reason}`);
    return;
  }
  const recorded = record!.digest!;
  const latest = await acrDigest(seams);
  const decision =
    latest === null || latest === recorded
      ? kitStaleness({ recorded, latest, indexDigests: null })
      : kitStaleness({ recorded, latest, indexDigests: await acrIndexDigests(seams) });
  seams.logger.verbose(`kit: ${decision.reason}`);
  if (decision.stale) {
    seams.logger.say(staleKitMessage(name));
  }
}

async function acrDigest(seams: Seams): Promise<string | null> {
  const result = await seams.runner.run(buildKitDigestArgs(KIT_REGISTRY, KIT_REPOSITORY), { timeoutMs: AZ_TIMEOUT_MS });
  const digest = result.stdout.trim();
  return result.code === 0 && digest !== "" ? digest : null;
}

/** The second az call, only made when the tag's digest differs from the recorded one. */
async function acrIndexDigests(seams: Seams): Promise<string[] | null> {
  const result = await seams.runner.run(buildKitIndexArgs(KIT_REGISTRY, KIT_REPOSITORY), { timeoutMs: AZ_TIMEOUT_MS });
  return result.code === 0 ? parseIndexDigests(result.stdout) : null;
}

async function allowKitSource(seams: Seams): Promise<void> {
  const current = await settingsGet(seams, ALLOWED_SOURCES_KEY);
  const decision = allowedSourcesDecision(current);
  if (!decision.needed) {
    seams.logger.verbose(`${ALLOWED_SOURCES_KEY} already allows the kit`);
    return;
  }
  const set = await seams.runner.run(buildAllowedSourcesSetArgs(decision.value), { timeoutMs: SBX_TIMEOUT_MS });
  if (set.code !== 0) {
    throw new Error(
      `could not allow kits from ${KIT_IMAGE}: ${set.stderr.trim()}. Set it by hand: sbx settings set ${ALLOWED_SOURCES_KEY} '${decision.value}'`
    );
  }
  seams.logger.say(`allowed kits from ${KIT_IMAGE}`);
}

async function raiseDockerVolume(seams: Seams): Promise<void> {
  const decision = volumeSizeDecision(await settingsGet(seams, DOCKER_VOLUME_KEY));
  if (!decision.needed) {
    seams.logger.verbose(decision.reason);
    return;
  }
  const set = await seams.runner.run(buildDockerVolumeSetArgs(), { timeoutMs: SBX_TIMEOUT_MS });
  if (set.code !== 0) {
    seams.logger.say(`could not raise ${DOCKER_VOLUME_KEY}, so the sandbox gets sbx's 10g default and the CFT images may not fit`);
    return;
  }
  seams.logger.say(decision.reason);
}

/**
 * One token, stored in both of sbx's registry scopes: sbx keeps its own secret store, so
 * `az acr login` on the host does nothing for it. It lasts about 3h, so the create refreshes it.
 */
async function refreshRegistrySecret(seams: Seams): Promise<void> {
  const token = await acrPullToken(seams);
  if (token === null) {
    seams.logger.say(`could not refresh the ${REGISTRY_HOST} pull token: run az login. sbx will try whatever token it already has.`);
    return;
  }
  for (const scope of SECRET_SCOPES) {
    const result = await seams.runner.run(buildSecretSetArgs(scope.flags), { stdin: token, timeoutMs: SBX_TIMEOUT_MS });
    if (result.code !== 0) {
      seams.logger.say(`could not store the ${REGISTRY_HOST} registry secret for ${scope.where}: ${result.stderr.trim()}`);
    }
  }
  seams.logger.verbose(`stored the ${REGISTRY_HOST} pull token in both of sbx's registry scopes`);
}

/** sbx mounts the history directory as a workspace, which needs it to exist on the host. */
async function prepareHost(seams: Seams, ctx: SbxContext & { historyDir: string }): Promise<void> {
  await seams.fs.mkdirp(ctx.historyDir);
}

async function settingsGet(seams: Seams, key: string): Promise<string | null> {
  const result = await seams.runner.run(buildSettingsGetArgs(key), { timeoutMs: SBX_TIMEOUT_MS });
  const value = result.stdout.trim();
  return result.code === 0 && value !== "" ? value : null;
}

async function gitToplevel(seams: Seams): Promise<string> {
  const result = await seams.runner.run(["git", "rev-parse", "--show-toplevel"], { cwd: seams.cwd });
  const top = result.stdout.trim();
  return result.code === 0 && top !== "" ? top : seams.cwd;
}

/**
 * Read from the checkout, not the home directory, so an `includeIf "gitdir:"` overlay giving
 * this workspace its own identity is the one forwarded. Both or neither.
 */
async function gitIdentity(seams: Seams, workspace: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, name] of [
    ["user.name", "CFT_GIT_AUTHOR_NAME"],
    ["user.email", "CFT_GIT_AUTHOR_EMAIL"]
  ] as const) {
    const result = await seams.runner.run(["git", "-C", workspace, "config", "--get", key]);
    const value = result.stdout.trim();
    if (result.code === 0 && value !== "") {
      out[name] = value;
    }
  }
  return Object.keys(out).length === 2 ? out : {};
}
