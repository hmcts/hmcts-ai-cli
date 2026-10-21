import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDir, statePath, tryStatePath } from "../system/state-dir.js";

export const REGISTRY_HOST = "hmctsprod.azurecr.io";
/** ACR's --expose-token issues a token for the null GUID, not for your own identity. */
export const TOKEN_USER = "00000000-0000-0000-0000-000000000000";
export const CACHE_FILE = "acr.json";

/** The token lasts about three hours, so anything that pulls refreshes it inside that. */
export const LOGIN_TTL_MS = 150 * 60 * 1000;
/** "Auto-updates the docker image" without paying a registry round trip on every launch. */
export const PULL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const UNAUTHORIZED = /unauthorized|authentication required|denied/i;
const AZ_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 20 * 60 * 1000;

/** Whether the docker login for the registry is stale. `retry` is the second attempt after an `unauthorized`. */
export function needsAcrLogin(input: { lastAt: number | null; now: number; retry: boolean }): Decision {
  if (input.retry) {
    return { yes: true, reason: `the registry answered unauthorized, so the ${REGISTRY_HOST} token is refreshed and the pull retried once` };
  }
  if (input.lastAt === null) {
    return { yes: true, reason: `no ${REGISTRY_HOST} login on record` };
  }
  const age = input.now - input.lastAt;
  if (age >= LOGIN_TTL_MS) {
    return { yes: true, reason: `the ${REGISTRY_HOST} login is ${Math.round(age / 60000)} minutes old` };
  }
  return { yes: false, reason: `the ${REGISTRY_HOST} login is ${Math.round(age / 60000)} minutes old, so it is still good` };
}

export function shouldPull(input: { policy: string | undefined; present: boolean; lastPullAt: number | null; now: number }): Decision {
  const policy = input.policy ?? "missing";
  if (policy === "never") {
    return { yes: false, reason: "HAI_PULL=never" };
  }
  if (policy === "always") {
    return { yes: true, reason: "HAI_PULL=always" };
  }
  if (policy !== "missing") {
    throw new Error(`HAI_PULL=${policy} is not always, missing or never`);
  }
  if (!input.present) {
    return { yes: true, reason: "the image is not on this machine yet" };
  }
  if (input.lastPullAt === null || input.now - input.lastPullAt >= PULL_INTERVAL_MS) {
    return { yes: true, reason: "the image has not been refreshed for a day" };
  }
  return { yes: false, reason: "the image is present and was refreshed within the day" };
}

/** Only the registry entry the nested daemon needs, so nothing else of the host's docker config travels. */
export function dockerConfigJson(token: string): string {
  const auth = Buffer.from(`${TOKEN_USER}:${token}`, "utf8").toString("base64");
  return `${JSON.stringify({ auths: { [REGISTRY_HOST]: { auth } } })}\n`;
}

export function isAcrImage(image: string): boolean {
  return image.startsWith(`${REGISTRY_HOST}/`);
}

/**
 * `az account show` still answers once the refresh token has expired, so it says nothing
 * about whether a token can still be minted. This asks for one.
 */
export async function hasAzSession(deps: { runner: Runner }): Promise<boolean> {
  const result = await deps.runner.run(["az", "account", "get-access-token", "--query", "expiresOn", "-o", "tsv"], { timeoutMs: AZ_TIMEOUT_MS });
  return result.code === 0;
}

/** Null when there is no usable az session, so the caller can carry on with a cached image. */
export async function acrPullToken(deps: { runner: Runner; logger: Logger }): Promise<string | null> {
  if (!(await hasAzSession(deps))) {
    deps.logger.verbose(`no usable az session, so no ${REGISTRY_HOST} pull token: run az login`);
    return null;
  }
  const result = await deps.runner.run(
    ["az", "acr", "login", "--name", REGISTRY_HOST.split(".")[0]!, "--expose-token", "--output", "tsv", "--query", "accessToken"],
    {
      timeoutMs: AZ_TIMEOUT_MS
    }
  );
  const token = result.stdout.trim();
  if (result.code !== 0 || token === "") {
    deps.logger.verbose(`could not get an ACR pull token for ${REGISTRY_HOST}`);
    return null;
  }
  return token;
}

/** Writes the host's docker login for the registry. The token goes in on stdin, never in argv. */
export async function acrLogin(deps: { runner: Runner; fs: Fs; env: Env; clock: Clock; logger: Logger }, token: string): Promise<boolean> {
  const result = await deps.runner.run(["docker", "login", REGISTRY_HOST, "-u", TOKEN_USER, "--password-stdin"], { stdin: token, timeoutMs: AZ_TIMEOUT_MS });
  if (result.code !== 0) {
    deps.logger.verbose(`docker login ${REGISTRY_HOST} failed: ${result.stderr.trim()}`);
    return false;
  }
  await writeStamp(deps, { loginAt: deps.clock.now() });
  return true;
}

export async function pullImage(
  deps: { runner: Runner; fs: Fs; env: Env; clock: Clock; logger: Logger },
  input: { image: string; policy: string | undefined }
): Promise<void> {
  const stamp = await readStamp(deps);
  const present = (await deps.runner.run(["docker", "image", "inspect", input.image])).code === 0;
  const decision = shouldPull({ policy: input.policy, present, lastPullAt: stamp.pullAt, now: deps.clock.now() });
  deps.logger.verbose(`${decision.yes ? "pulling" : "not pulling"} ${input.image}: ${decision.reason}`);
  if (!decision.yes) {
    return;
  }
  if (!(await pullOnce(deps, input.image, stamp.loginAt, false)) && !present) {
    throw new Error(`could not pull ${input.image}, and it is not on this machine. Run az login, check the F5 VPN, then try again.`);
  }
}

async function pullOnce(
  deps: { runner: Runner; fs: Fs; env: Env; clock: Clock; logger: Logger },
  image: string,
  lastLoginAt: number | null,
  retry: boolean
): Promise<boolean> {
  if (isAcrImage(image)) {
    const login = needsAcrLogin({ lastAt: lastLoginAt, now: deps.clock.now(), retry });
    deps.logger.verbose(`${REGISTRY_HOST}: ${login.reason}`);
    if (login.yes) {
      const token = await acrPullToken(deps);
      if (token !== null) {
        await acrLogin(deps, token);
      }
    }
  }
  const result = await deps.runner.run(["docker", "pull", image], { timeoutMs: PULL_TIMEOUT_MS });
  if (result.code === 0) {
    await writeStamp(deps, { pullAt: deps.clock.now() });
    return true;
  }
  if (!retry && isAcrImage(image) && UNAUTHORIZED.test(result.stderr)) {
    return await pullOnce(deps, image, null, true);
  }
  deps.logger.verbose(`could not pull ${image}: ${result.stderr.trim()}`);
  return false;
}

async function readStamp(deps: { fs: Fs; env: Env }): Promise<Stamp> {
  const path = tryStatePath(deps.env, CACHE_FILE);
  const contents = path === null ? null : await deps.fs.readText(path);
  if (contents === null) {
    return { loginAt: null, pullAt: null };
  }
  try {
    const parsed = JSON.parse(contents) as Partial<Record<keyof Stamp, unknown>>;
    return { loginAt: finite(parsed.loginAt), pullAt: finite(parsed.pullAt) };
  } catch {
    return { loginAt: null, pullAt: null };
  }
}

async function writeStamp(deps: { fs: Fs; env: Env; logger: Logger }, patch: Partial<Stamp>): Promise<void> {
  try {
    const merged = { ...(await readStamp(deps)), ...patch };
    await deps.fs.mkdirp(stateDir(deps.env), { mode: STATE_DIR_MODE });
    await deps.fs.writeText(statePath(deps.env, CACHE_FILE), `${JSON.stringify(merged)}\n`, { mode: STATE_FILE_MODE });
  } catch {
    deps.logger.verbose(`could not record the ${REGISTRY_HOST} login time`);
  }
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface Stamp {
  loginAt: number | null;
  pullAt: number | null;
}

export interface Decision {
  yes: boolean;
  reason: string;
}
