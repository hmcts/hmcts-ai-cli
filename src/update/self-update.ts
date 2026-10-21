import { fileURLToPath } from "node:url";
import { messageOf } from "../log/error-message.js";
import { type Env, isEnabled } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Seams } from "../system/seams.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDir, statePath, tryStatePath } from "../system/state-dir.js";
import { FEED_URL, latestFromPackument, packumentUrl } from "./feed.js";
import { detectPackageManager, PACKAGE_NAME } from "./package-manager.js";
import { isNewer } from "./version.js";

export const PACKUMENT_URL = packumentUrl(FEED_URL, PACKAGE_NAME);
export const CACHE_FILE = "update.json";
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 1500;
const INSTALL_TIMEOUT_MS = 120_000;

/** The placeholder version in the repo; CI owns the real one and bumps it on publish. */
export const UNPUBLISHED_VERSION = "0.0.0";

/**
 * Whether to leave the installed version alone, and what to say about it. First match
 * wins, so the precedence between the switches is this one table.
 */
export function skipUpdateCheck(input: { env: Env; currentVersion: string }): SkipUpdateCheck {
  const { env } = input;
  if (isEnabled(env, "HAI_NO_UPDATE")) {
    return { skip: true, reason: "HAI_NO_UPDATE=1, so the update check is skipped" };
  }
  if (isEnabled(env, "HAI_UPDATED")) {
    // We are the re-exec after an update. Checking again here is how a broken release
    // turns into a loop, and saying anything would be noise on every post-update run.
    return { skip: true, reason: null };
  }
  if (isEnabled(env, "HAI_DRY_RUN")) {
    // A dry run shows what would happen, so it may not install anything or even ask.
    return { skip: true, reason: "HAI_DRY_RUN=1, so the update check is skipped" };
  }
  if (isEnabled(env, "HAI_OFFLINE")) {
    return { skip: true, reason: "HAI_OFFLINE=1, so the update check is skipped" };
  }
  if (input.currentVersion === UNPUBLISHED_VERSION) {
    // An unpublished local build: every published version looks newer, so a working copy
    // would replace itself with the feed's copy on every single run.
    return { skip: true, reason: `running an unpublished ${UNPUBLISHED_VERSION} build, so the update check is skipped` };
  }
  return { skip: false, reason: null };
}

/**
 * Automatic and quiet: there is no subcommand because every name worth taking already
 * belongs to `claude`. Any network trouble is invisible unless HAI_VERBOSE=1, because an
 * unreachable feed is not the engineer's problem right now.
 */
export async function maybeSelfUpdate(deps: { seams: Seams; currentVersion: string }): Promise<SelfUpdateOutcome> {
  const { seams } = deps;
  const skip = skipUpdateCheck({ env: seams.env, currentVersion: deps.currentVersion });
  if (skip.skip) {
    if (skip.reason !== null) {
      seams.logger.verbose(skip.reason);
    }
    return { reExec: false };
  }

  const latest = await latestVersion(deps);
  if (latest === null || !isNewer(latest, deps.currentVersion)) {
    return { reExec: false };
  }

  const plan = detectPackageManager({
    execPath: seams.execPath,
    packagePath: packageRoot(),
    npmCommand: seams.env.npm_command,
    // Checked up front so an unwritable prefix becomes a printed command rather than a
    // failed install. Never sudo.
    prefixWritable: await seams.fs.isWritable(packageRoot())
  });
  if (plan.manualCommand !== null) {
    seams.logger.say(`${PACKAGE_NAME} ${latest} is out (you have ${deps.currentVersion}); ${plan.reason}. Update with: ${plan.manualCommand.join(" ")}`);
    return { reExec: false };
  }
  if (plan.command === null) {
    seams.logger.verbose(`not updating to ${latest}: ${plan.reason}`);
    return { reExec: false };
  }

  seams.logger.say(`updating ${PACKAGE_NAME} ${deps.currentVersion} -> ${latest} (${plan.reason})`);
  const result = await seams.runner.run(plan.command, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) {
    seams.logger.say(`could not update automatically; run: ${plan.command.join(" ")}`);
    seams.logger.verbose(result.stderr.trim());
    return { reExec: false };
  }
  return { reExec: true };
}

export function packageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

export async function readCurrentVersion(deps: { fs: Fs }): Promise<string> {
  const contents = await deps.fs.readText(fileURLToPath(new URL("../../package.json", import.meta.url)));
  if (contents === null) {
    return UNPUBLISHED_VERSION;
  }
  try {
    return String((JSON.parse(contents) as { version?: unknown }).version ?? UNPUBLISHED_VERSION);
  } catch {
    return UNPUBLISHED_VERSION;
  }
}

/** Reads the cache first, so most launches cost no request at all. The feed allows anonymous reads. */
async function latestVersion(deps: { seams: Seams }): Promise<string | null> {
  const { seams } = deps;
  const cached = await readCache(seams);
  if (cached !== null) {
    return cached;
  }
  try {
    const res = await seams.net.fetch(PACKUMENT_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`the feed answered ${res.status}`);
    }
    const latest = latestFromPackument(await res.json());
    if (latest === null) {
      throw new Error("the feed named no published version");
    }
    await writeCache(seams, latest);
    return latest;
  } catch (err) {
    seams.logger.verbose(`could not check for a newer ${PACKAGE_NAME}: ${messageOf(err)}`);
    return null;
  }
}

async function readCache(seams: Seams): Promise<string | null> {
  const path = tryStatePath(seams.env, CACHE_FILE);
  const contents = path === null ? null : await seams.fs.readText(path);
  if (contents === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as { at?: unknown; latest?: unknown };
    const at = Number(parsed.at);
    if (!Number.isFinite(at) || seams.clock.now() - at >= CACHE_TTL_MS || typeof parsed.latest !== "string") {
      return null;
    }
    return parsed.latest;
  } catch {
    return null;
  }
}

async function writeCache(seams: Seams, latest: string): Promise<void> {
  try {
    await seams.fs.mkdirp(stateDir(seams.env), { mode: STATE_DIR_MODE });
    await seams.fs.writeText(statePath(seams.env, CACHE_FILE), `${JSON.stringify({ at: seams.clock.now(), latest })}\n`, { mode: STATE_FILE_MODE });
  } catch {
    seams.logger.verbose("could not write the update cache");
  }
}

export interface SelfUpdateOutcome {
  reExec: boolean;
}

export interface SkipUpdateCheck {
  skip: boolean;
  /** Null when there is nothing worth saying, even under verbosity. */
  reason: string | null;
}
