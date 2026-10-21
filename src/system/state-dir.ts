import { join } from "node:path";
import type { Env } from "./env.js";

export const STATE_DIR_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;

export function stateDir(env: Env): string {
  const dir = tryStateDir(env);
  if (dir === null) {
    throw new Error("neither XDG_STATE_HOME nor HOME is set, so there is nowhere to keep hai's state");
  }
  return dir;
}

/** Null rather than a throw, for the caches: losing one is an inconvenience, not a failure. */
export function tryStateDir(env: Env): string | null {
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg !== "") {
    return join(xdg, "hai");
  }
  const home = env.HOME;
  if (home === undefined || home === "") {
    return null;
  }
  return join(home, ".local", "state", "hai");
}

export function statePath(env: Env, name: string): string {
  return join(stateDir(env), name);
}

export function tryStatePath(env: Env, name: string): string | null {
  const dir = tryStateDir(env);
  return dir === null ? null : join(dir, name);
}
