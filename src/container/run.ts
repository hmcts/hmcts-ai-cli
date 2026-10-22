import { join } from "node:path";
import { HELPER_FILE } from "../auth/gateway.js";
import { buildClaudeArgs } from "../claude/args.js";
import { buildSettings, materialiseSettings } from "../claude/settings.js";
import { extractUserSettings, mergeSettings, readUserSettings } from "../claude/user-settings.js";
import { describeEnv } from "../log/redact.js";
import { isEnabled } from "../system/env.js";
import type { RunResult } from "../system/runner.js";
import type { Seams } from "../system/seams.js";
import { acrPullToken, dockerConfigJson, pullImage } from "./acr.js";
import { seedClaudeJson } from "./claude-json.js";
import { passthroughEnv, splitEnv } from "./container-env.js";
import { discoverDns } from "./dns.js";
import {
  buildDockerArgs,
  buildDockerConfigExecArgs,
  buildSecretExecArgs,
  buildSessionExecArgs,
  type ContainerContext,
  DEFAULT_IMAGE,
  DOCKER_BIN,
  SECRETS_DIR
} from "./docker-args.js";
import { hostPrepPaths } from "./host-prep.js";
import { lockPath, releaseLock, takeLock } from "./lock.js";
import { type DevcontainerSpec, defaultSpec, parseDevcontainer, resolveMounts, type SubstitutionVars } from "./mounts.js";
import { type PortWatch, startPortWatch, sweepSidecars } from "./port-watch.js";
import { choosePorts, portClashMessage } from "./ports.js";
import { stagedRuntimeDir, stageRuntime } from "./runtime-staging.js";
import { dockerVolumeName, NETWORK_NAME, sessionName } from "./session.js";

const START_TIMEOUT_MS = 120_000;
const DOCKERD_ATTEMPTS = 60;
const DOCKERD_POLL_MS = 1000;

/**
 * Container mode: run Claude Code inside the CFT workspace image with a nested Docker
 * engine, from a bare host. The route is resolved on the host — this is where az, the
 * agent-hub and the Key Vault are reachable, and on macOS a mounted ~/.azure may hold no
 * usable session at all — and the credentials are delivered over a `docker exec` stdin.
 */
export async function runContainerMode(input: {
  seams: Seams;
  forwarded: string[];
  added: Record<string, string>;
  hasGateway: boolean;
  workspaceRoot: string | null;
  pluginDirs: string[];
}): Promise<void> {
  const { seams } = input;
  const { secretEnv, ...ctx } = await gatherContext(input);
  const claudeArgv = await containerClaudeArgs(input, ctx);
  const dockerArgv = buildDockerArgs(ctx);
  const sessionArgv = buildSessionExecArgs(ctx, claudeArgv);

  if (isEnabled(seams.env, "HAI_DRY_RUN")) {
    seams.stdout(`${dockerArgv.join(" ")}\n`);
    seams.stdout(`${sessionArgv.join(" ")}\n`);
    seams.stdout(`  secrets delivered on a docker exec stdin: ${Object.keys(secretEnv).sort().join(", ") || "none"}\n`);
    for (const line of describeEnv(input.added)) {
      seams.stdout(`  ${line}\n`);
    }
    seams.exit(0);
  }

  await prepareHost(input, ctx);
  const lock = await takeLock(seams, {
    path: lockPath({ home: ctx.home, workdir: ctx.workdir }),
    sessionName: ctx.sessionName,
    pid: seams.pid,
    allowConcurrent: isEnabled(seams.env, "HAI_ALLOW_CONCURRENT"),
    ownHistory: isEnabled(seams.env, "HAI_OWN_HISTORY")
  });

  let started = false;
  let watch: PortWatch | null = null;
  let code: number;
  try {
    await pullImage(seams, { image: ctx.image, policy: seams.env.HAI_PULL });
    await ensureNetwork(seams, ctx.network);
    started = await ensureContainer(seams, ctx, dockerArgv);
    await deliverSecrets(seams, ctx, secretEnv);
    await deliverDockerConfig(seams, ctx);
    // Only the session that started the container watches it: a reattaching one would be a
    // second watcher racing the first for the same host ports.
    if (started) {
      watch = await startPortWatch(seams, ctx, { published: ctx.ports });
    }
    code = await seams.runner.interactive(sessionArgv);
  } finally {
    await watch?.stop();
    if (started) {
      // The session is over, and a stopped container holds a nested engine whose state
      // is useless: the image cache it was using lives in the named volume, not here.
      await seams.runner.run([DOCKER_BIN, "rm", "-f", ctx.sessionName], { timeoutMs: START_TIMEOUT_MS });
      seams.logger.verbose(`removed ${ctx.sessionName}`);
      await sweepSidecars(seams, ctx.sessionName);
    }
    await releaseLock(seams, lock);
  }
  seams.exit(code);
}

/** The context plus what only the launch needs: the credentials, which no argv may carry, and HOME. */
type LaunchContext = ContainerContext & { home: string; secretEnv: Record<string, string> };

async function gatherContext(input: { seams: Seams; added: Record<string, string> }): Promise<LaunchContext> {
  const { seams } = input;
  const home = seams.env.HOME;
  if (home === undefined || home === "") {
    throw new Error("HOME is not set, so there is no way to work out what to mount into the container");
  }
  const repoPath = await gitToplevel(seams);
  const session = sessionName({ repoPath, requested: seams.env.HAI_SESSION });
  seams.logger.verbose(`container session ${session} for ${repoPath}`);

  // Before the probe, not after: a sidecar a SIGKILLed session left behind is holding one of
  // the very ports about to be probed, and probing first reports it as a clash with its own
  // corpse. A session that is up owns its sidecars, so that one is reattached to untouched.
  if (!(await sessionRunning(seams, session))) {
    await sweepSidecars(seams, session);
  }
  // Up front, so a mistyped HAI_PORTS fails before anything has been prepared, and so one
  // port another process already holds costs its own mapping rather than the whole launch:
  // `docker run` publishes all or nothing.
  const ports = await choosePorts(seams, seams.env.HAI_PORTS);

  const spec = await readSpec(seams, { repoPath, home });
  const containerHome = `/home/${spec.containerUser}`;
  const dns = await discoverDns(seams);
  seams.logger.verbose(`container DNS: ${dns.reason}`);
  if (dns.servers.length === 0 && seams.platform !== "darwin") {
    seams.logger.say(dns.reason);
  }

  const ownHistory = isEnabled(seams.env, "HAI_OWN_HISTORY");
  const mounts = resolveMounts({
    spec,
    shareCaches: isEnabled(seams.env, "HAI_SHARE_CACHES"),
    ownHistory,
    sessionName: session,
    containerHome,
    extra: seams.env.HAI_MOUNTS
  });
  const { open, secret } = splitEnv(input.added);
  const runtimeDir = isEnabled(seams.env, "HAI_DRY_RUN") ? stagedRuntimeDir(seams.env) : await stageRuntime(seams);
  const image = seams.env.HAI_IMAGE === undefined || seams.env.HAI_IMAGE === "" ? DEFAULT_IMAGE : seams.env.HAI_IMAGE;

  return {
    image,
    sessionName: session,
    network: NETWORK_NAME,
    platform: seams.platform,
    repoPath,
    workdir: seams.cwd,
    containerUser: spec.containerUser,
    containerHome,
    dockerVolume: dockerVolumeName(session),
    secretsDir: SECRETS_DIR,
    runtimeDir,
    dns: dns.servers,
    ports,
    publicPorts: isEnabled(seams.env, "HAI_PORTS_PUBLIC"),
    mounts,
    tty: seams.hiddenInput.isTty,
    env: {
      ...passthroughEnv(seams.env),
      ...open,
      ...(await gitIdentity(seams)),
      HAI_IN_CONTAINER: "1",
      HAI_ENV_READY: "1",
      HAI_SECRETS_DIR: SECRETS_DIR,
      HAI_NESTED_DNS: dns.servers.join(",")
    },
    secretEnv: secret,
    home
  };
}

/**
 * The container's own state directory is not the host's, so the gateway route's
 * apiKeyHelper is named at its container path and installed there by the entrypoint, and
 * the settings go inline rather than as a file the host would have to write inside.
 */
async function containerClaudeArgs(
  input: { seams: Seams; forwarded: string[]; hasGateway: boolean; workspaceRoot: string | null; pluginDirs: string[] },
  ctx: ContainerContext
): Promise<string[]> {
  const { seams } = input;
  const user = extractUserSettings(input.forwarded);
  const ours = buildSettings({
    inWorkspace: input.workspaceRoot !== null,
    apiKeyHelperPath: input.hasGateway ? join(ctx.containerHome, ".local", "state", "hai", HELPER_FILE) : undefined
  });
  const merged = mergeSettings(ours, user.value === undefined ? {} : await readUserSettings(seams, user.value));
  for (const warning of merged.warnings) {
    seams.logger.say(warning);
  }
  return buildClaudeArgs({
    settings: await materialiseSettings(seams, merged.settings, false),
    skipPermissions: input.workspaceRoot !== null && seams.env.HAI_PERMISSIONS !== "ask",
    pluginDirs: input.pluginDirs,
    userArgs: user.argv
  });
}

/** devcontainer.json's initializeCommand, in hai: every bind source has to exist first. */
async function prepareHost(input: { seams: Seams }, ctx: ContainerContext & { home: string }): Promise<void> {
  const { seams } = input;
  const { dirs, files } = hostPrepPaths({ home: ctx.home, mounts: ctx.mounts });
  for (const dir of dirs) {
    await seams.fs.mkdirp(dir);
  }
  for (const file of files) {
    if (!(await seams.fs.exists(file))) {
      await seams.fs.writeText(file, "");
    }
  }
  await seedClaudeJson(seams, { home: ctx.home, workspacePath: ctx.workdir, pid: seams.pid });
}

async function ensureNetwork(seams: Seams, network: string): Promise<void> {
  if ((await seams.runner.run([DOCKER_BIN, "network", "inspect", network])).code === 0) {
    return;
  }
  const created = await seams.runner.run([DOCKER_BIN, "network", "create", network]);
  if (created.code !== 0) {
    throw new Error(`could not create the ${network} Docker network: ${created.stderr.trim()}`);
  }
}

function inspectRunning(seams: Seams, sessionName: string): Promise<RunResult> {
  return seams.runner.run([DOCKER_BIN, "inspect", "-f", "{{.State.Running}}", sessionName]);
}

async function sessionRunning(seams: Seams, sessionName: string): Promise<boolean> {
  const existing = await inspectRunning(seams, sessionName);
  return existing.code === 0 && existing.stdout.trim() === "true";
}

/** True when this run started the container, which is the only case that may remove it. */
async function ensureContainer(seams: Seams, ctx: ContainerContext, dockerArgv: string[]): Promise<boolean> {
  const existing = await inspectRunning(seams, ctx.sessionName);
  if (existing.code === 0 && existing.stdout.trim() === "true") {
    seams.logger.verbose(`${ctx.sessionName} is already up, so this session reattaches to it`);
    return false;
  }
  if (existing.code === 0) {
    await seams.runner.run([DOCKER_BIN, "rm", "-f", ctx.sessionName], { timeoutMs: START_TIMEOUT_MS });
  }
  const created = await seams.runner.run(dockerArgv, { timeoutMs: START_TIMEOUT_MS });
  if (created.code !== 0) {
    const clash = portClashMessage({ stderr: created.stderr, published: ctx.ports });
    throw new Error(clash ?? `could not start the hai container: ${created.stderr.trim()}`);
  }
  await waitForNestedDocker(seams, ctx);
  return true;
}

async function waitForNestedDocker(seams: Seams, ctx: ContainerContext): Promise<void> {
  for (let attempt = 0; attempt < DOCKERD_ATTEMPTS; attempt += 1) {
    const result = await seams.runner.run([
      DOCKER_BIN,
      "exec",
      "--user",
      ctx.containerUser,
      ctx.sessionName,
      "docker",
      "version",
      "--format",
      "{{.Server.Version}}"
    ]);
    if (result.code === 0) {
      seams.logger.verbose(`nested Docker engine ${result.stdout.trim()} is up`);
      return;
    }
    await seams.clock.sleep(DOCKERD_POLL_MS);
  }
  seams.logger.say("the nested Docker engine did not come up; docker, cftlib and Testcontainers will not work in this session");
}

async function deliverSecrets(seams: Seams, ctx: ContainerContext, secretEnv: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(secretEnv)) {
    const result = await seams.runner.run(buildSecretExecArgs(ctx, name), { stdin: value });
    if (result.code !== 0) {
      throw new Error(`could not hand ${name} to the container: ${result.stderr.trim()}`);
    }
  }
  seams.logger.verbose(`delivered ${Object.keys(secretEnv).length} credential(s) on a docker exec stdin`);
}

/**
 * The nested daemon starts with an empty registry config, so every hmctsprod pull inside
 * — cftlib's IDAM simulator, XUI — is refused. The token is minted on the host because
 * that is where the az session reliably is.
 */
async function deliverDockerConfig(seams: Seams, ctx: ContainerContext): Promise<void> {
  const token = await acrPullToken(seams);
  if (token === null) {
    seams.logger.verbose("the nested Docker engine has no hmctsprod pull token; run az login if it needs to pull HMCTS images");
    return;
  }
  const result = await seams.runner.run(buildDockerConfigExecArgs(ctx), { stdin: dockerConfigJson(token) });
  if (result.code !== 0) {
    seams.logger.verbose(`could not give the nested Docker engine a pull token: ${result.stderr.trim()}`);
  }
}

async function readSpec(seams: Seams, input: { repoPath: string; home: string }): Promise<DevcontainerSpec> {
  const vars: SubstitutionVars = { env: seams.env, workspaceFolder: input.repoPath };
  const path = join(input.repoPath, ".devcontainer", "devcontainer.json");
  const json = await seams.fs.readText(path);
  const spec = json === null ? null : parseDevcontainer(json, vars);
  if (spec === null) {
    const fallback = defaultSpec(vars);
    seams.logger.verbose(`mounts from ${fallback.source}`);
    return fallback;
  }
  seams.logger.verbose(`mounts from ${spec.source}`);
  return spec;
}

async function gitToplevel(seams: Seams): Promise<string> {
  const result = await seams.runner.run(["git", "rev-parse", "--show-toplevel"], { cwd: seams.cwd });
  const top = result.stdout.trim();
  return result.code === 0 && top !== "" ? top : seams.cwd;
}

async function gitIdentity(seams: Seams): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, name] of [
    ["user.name", "CFT_GIT_AUTHOR_NAME"],
    ["user.email", "CFT_GIT_AUTHOR_EMAIL"]
  ] as const) {
    const result = await seams.runner.run(["git", "config", "--global", "--get", key]);
    const value = result.stdout.trim();
    if (result.code === 0 && value !== "") {
      out[name] = value;
    }
  }
  return out;
}
