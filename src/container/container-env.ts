import { isSecretEnvKey } from "../log/redact.js";
import type { Env } from "../system/env.js";

/**
 * Only these are carried over from the host's environment. The container gets a curated
 * set rather than a copy, because `docker run --env` is recorded in the container config:
 * forwarding the lot would put whatever else the shell is holding on disk.
 */
export const PASSTHROUGH = ["HAI_VERBOSE", "HAI_ROUTE", "HAI_OFFLINE", "HAI_NO_UPDATE", "AGENT_HUB_PLUGINS", "TERM", "COLORTERM", "LANG"];

/**
 * Splits the route's environment on which names hold a credential. Both halves travel per
 * session, because a second terminal reattaches to the first's container: the open half as
 * `--env` on the session's own `docker exec`, the secret half on a `docker exec` stdin.
 * Neither goes on `docker run`, which is create-time only.
 */
export function splitEnv(env: Record<string, string>): { open: Record<string, string>; secret: Record<string, string> } {
  const open: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvKey(name)) {
      secret[name] = value;
    } else {
      open[name] = value;
    }
  }
  return { open, secret };
}

export function passthroughEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      out[name] = value;
    }
  }
  return out;
}
