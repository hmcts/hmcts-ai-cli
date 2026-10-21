import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDir, statePath, tryStatePath } from "../system/state-dir.js";
import { isRoute, type RouteResolution } from "./route.js";

export const CACHE_FILE = "auth.json";
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Routes and group membership only. A credential is never written here, or anywhere else on disk. */
export async function readAuthCache(deps: { fs: Fs; env: Env; clock: Clock }, key: string): Promise<AuthCacheEntry | null> {
  const path = tryStatePath(deps.env, CACHE_FILE);
  const contents = path === null ? null : await deps.fs.readText(path);
  if (contents === null) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }
  const entry = parsed[key];
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  return sanitise(entry as Record<string, unknown>, deps.clock.now());
}

export async function writeAuthCache(deps: { fs: Fs; env: Env; clock: Clock }, key: string, entry: AuthCacheEntry): Promise<void> {
  const path = statePath(deps.env, CACHE_FILE);
  const existing = await deps.fs.readText(path);
  let all: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      all = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      all = {};
    }
  }
  all[key] = entry;
  await deps.fs.mkdirp(stateDir(deps.env), { mode: STATE_DIR_MODE });
  await deps.fs.writeText(path, `${JSON.stringify(all, null, 2)}\n`, { mode: STATE_FILE_MODE });
}

function sanitise(entry: Record<string, unknown>, now: number): AuthCacheEntry {
  const out: AuthCacheEntry = {};
  const route = entry.route as Record<string, unknown> | undefined;
  if (route !== undefined && isFresh(route.at, now) && typeof route.route === "string" && isRoute(route.route) && typeof route.credentialSource === "string") {
    out.route = {
      at: Number(route.at),
      route: route.route,
      credentialSource: route.credentialSource as RouteResolution["credentialSource"],
      reasons: Array.isArray(route.reasons) ? route.reasons.filter((r): r is string => typeof r === "string") : []
    };
  }
  const group = entry.group as Record<string, unknown> | undefined;
  if (group !== undefined && isFresh(group.at, now) && typeof group.isMember === "boolean") {
    out.group = { at: Number(group.at), isMember: group.isMember };
  }
  return out;
}

function isFresh(at: unknown, now: number): boolean {
  const stamp = Number(at);
  return Number.isFinite(stamp) && now - stamp < CACHE_TTL_MS;
}

export interface AuthCacheEntry {
  route?: { at: number } & RouteResolution;
  group?: { at: number; isMember: boolean };
}
