import { messageOf } from "../log/error-message.js";
import { redact } from "../log/redact.js";
import type { Clock } from "../system/clock.js";
import { asProcessEnv, type Env } from "../system/env.js";
import type { Runner } from "../system/runner.js";

const AZ_TIMEOUT_MS = 30_000;
const FALLBACK_LIFETIME_MS = 30 * 60 * 1000;

/**
 * az reports expiry as either `expires_on` (epoch seconds) or `expiresOn` (a local-time string)
 * depending on CLI version; an unknown shape falls back to a short lifetime, not to expired.
 */
export function parseAzToken(stdout: string, now: number): AzToken {
  const parsed = JSON.parse(stdout) as { accessToken?: string; expires_on?: unknown; expiresOn?: unknown };
  if (parsed.accessToken === undefined || parsed.accessToken === "") {
    throw new Error("az returned no accessToken");
  }
  let expiresAt = Number.NaN;
  if (Number.isFinite(Number(parsed.expires_on))) {
    expiresAt = Number(parsed.expires_on) * 1000;
  } else if (typeof parsed.expiresOn === "string") {
    expiresAt = Date.parse(parsed.expiresOn);
  }
  if (!Number.isFinite(expiresAt)) {
    expiresAt = now + FALLBACK_LIFETIME_MS;
  }
  return { token: parsed.accessToken, expiresAt };
}

export async function getAzAccessToken(deps: { runner: Runner; env: Env; clock: Clock }, scope: string): Promise<AzToken> {
  const result = await deps.runner.run(["az", "account", "get-access-token", "--scope", scope, "-o", "json"], {
    env: asProcessEnv(deps.env),
    timeoutMs: AZ_TIMEOUT_MS
  });
  if (result.code !== 0) {
    throw new Error(`az account get-access-token failed: ${azFailureHint(result.stderr)}`);
  }
  try {
    return parseAzToken(result.stdout, deps.clock.now());
  } catch (err) {
    throw new Error(`could not read the token az returned: ${redact(messageOf(err))}`);
  }
}

export function azFailureHint(stderr: string): string {
  const firstLine = redact(stderr).trim().split("\n", 1).join("");
  if (firstLine === "") {
    return "no output; is the az CLI installed and are you logged in (az login)?";
  }
  return firstLine;
}

export interface AzToken {
  token: string;
  expiresAt: number;
}
