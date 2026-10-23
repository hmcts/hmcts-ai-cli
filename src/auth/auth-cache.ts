import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDir, statePath, tryStatePath } from "../system/state-dir.js";

export const CACHE_FILE = "auth.json";

/**
 * Twelve hours, and it means it now that a cache hit no longer re-stamps `at`: a change of
 * group is picked up within a working day, for at most two `az rest` calls a day per
 * identity. Shortening it would mostly cost the people the block protects — each expiry is
 * a fresh Graph call, and a call az cannot make answers "unknown", which refuses the
 * personal routes outright. Delete this file to force a re-check sooner.
 */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Group membership only, keyed by the signed-in identity. A credential is never written
 * here, or anywhere else on disk. Only the default path reaches this at all: an explicit
 * `HAI_ROUTE` resolves no membership, so it asks `az` nothing and has nothing to cache.
 */
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
  group?: { at: number; isMember: boolean };
}
