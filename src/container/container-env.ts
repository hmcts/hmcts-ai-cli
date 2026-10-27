import { isSecretEnvKey } from "../log/redact.js";
import type { Env } from "../system/env.js";

/**
 * Only these are carried over from the host's environment: `docker run --env` is recorded in
 * the container config, so forwarding the lot would put whatever the shell holds on disk.
 */
export const PASSTHROUGH = ["HAI_VERBOSE", "HAI_ROUTE", "HAI_OFFLINE", "HAI_NO_UPDATE", "AGENT_HUB_PLUGINS", "TERM", "COLORTERM", "LANG"];

/**
 * Splits the route's environment on which names hold a credential: the open half goes as
 * `--env` on the session's `docker exec`, the secret half on a `docker exec` stdin.
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
