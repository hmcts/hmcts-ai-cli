import { join } from "node:path";
import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";

/** What Claude Code writes when a proxy manages its credentials, so it is not evidence of a BYO licence. */
export const PROXY_MANAGED_SENTINEL = "sk-ant-oat01-proxy-managed";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";

const KEYCHAIN_TIMEOUT_MS = 10_000;

export function credentialsPath(env: Env): string | null {
  const home = env.HOME;
  return home === undefined || home === "" ? null : join(home, ".claude", ".credentials.json");
}

export function hasLiveClaudeAiLogin(contents: string, now: number): boolean {
  let parsed: { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
  try {
    parsed = JSON.parse(contents) as typeof parsed;
  } catch {
    return false;
  }
  const oauth = parsed.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || accessToken === "" || accessToken === PROXY_MANAGED_SENTINEL) {
    return false;
  }
  const expiresAt = Number(oauth?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export async function hasHostClaudeCredential(deps: { fs: Fs; runner: Runner; clock: Clock; env: Env; platform: string; logger: Logger }): Promise<boolean> {
  const path = credentialsPath(deps.env);
  const contents = path === null ? null : await deps.fs.readText(path);
  if (contents !== null) {
    return hasLiveClaudeAiLogin(contents, deps.clock.now());
  }
  if (deps.platform !== "darwin") {
    return false;
  }
  // macOS keeps the same JSON in the login keychain rather than on disk.
  const result = await deps.runner.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeoutMs: KEYCHAIN_TIMEOUT_MS });
  if (result.code !== 0) {
    deps.logger.verbose(
      `no claude.ai login found on disk or in the login keychain; to use your own licence run \`claude setup-token\` once and export the result as CLAUDE_CODE_OAUTH_TOKEN`
    );
    return false;
  }
  return hasLiveClaudeAiLogin(result.stdout, deps.clock.now());
}
