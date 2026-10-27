import { asProcessEnv, type Env } from "../system/env.js";
import type { Runner } from "../system/runner.js";

const AZ_TIMEOUT_MS = 30_000;

export function parseAzAccount(stdout: string): AzAccount | null {
  let parsed: { tenantId?: unknown; user?: { name?: unknown } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return null;
  }
  const tenantId = typeof parsed.tenantId === "string" ? parsed.tenantId : "";
  const userId = typeof parsed.user?.name === "string" ? parsed.user.name : "";
  if (tenantId === "" || userId === "") {
    return null;
  }
  return { tenantId, userId };
}

/**
 * Null when az cannot say who we are. The cache key is `user.name`, the signed-in UPN, because
 * reading the directory object id needs a Graph read many HMCTS accounts are not granted.
 */
export async function readAzAccount(deps: { runner: Runner; env: Env }): Promise<AzAccount | null> {
  const result = await deps.runner.run(["az", "account", "show", "-o", "json"], {
    env: asProcessEnv(deps.env),
    timeoutMs: AZ_TIMEOUT_MS
  });
  if (result.code !== 0) {
    return null;
  }
  return parseAzAccount(result.stdout);
}

export function accountCacheKey(account: AzAccount): string {
  return `${account.tenantId}:${account.userId}`;
}

export interface AzAccount {
  tenantId: string;
  userId: string;
}
