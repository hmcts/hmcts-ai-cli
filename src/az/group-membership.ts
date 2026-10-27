import type { Logger } from "../log/logger.js";
import { asProcessEnv, type Env } from "../system/env.js";
import type { Runner } from "../system/runner.js";
import { azFailureHint } from "./token.js";

/** DTSSE AI Gateway Bedrock Developer. */
export const DEFAULT_BEDROCK_GROUP_ID = "ca558e81-86b6-42d0-ba60-b6fcbce6eb1c";

const GRAPH_URI = "https://graph.microsoft.com/v1.0/me/checkMemberGroups";
const AZ_TIMEOUT_MS = 30_000;

export function bedrockGroupId(env: Env): string {
  const override = env.HAI_BEDROCK_GROUP_ID;
  return override !== undefined && override !== "" ? override : DEFAULT_BEDROCK_GROUP_ID;
}

/** Null when the response cannot be read at all, which is "unknown", not "not a member". */
export function parseCheckMemberGroups(stdout: string, groupId: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const value = Array.isArray(parsed) ? parsed : (parsed as { value?: unknown })?.value;
  if (!Array.isArray(value)) {
    return null;
  }
  return value.includes(groupId);
}

/**
 * checkMemberGroups rather than `az ad group member check`: the latter needs a directory read
 * many HMCTS accounts do not have, while this endpoint answers for the caller's own membership.
 */
export async function checkBedrockGroupMembership(deps: { runner: Runner; env: Env; logger: Logger }): Promise<boolean | null> {
  const groupId = bedrockGroupId(deps.env);
  const result = await deps.runner.run(
    ["az", "rest", "--method", "POST", "--uri", GRAPH_URI, "--headers", "Content-Type=application/json", "--body", JSON.stringify({ groupIds: [groupId] })],
    { env: asProcessEnv(deps.env), timeoutMs: AZ_TIMEOUT_MS }
  );
  if (result.code !== 0) {
    deps.logger.verbose(`could not check Bedrock group membership: ${azFailureHint(result.stderr)}`);
    return null;
  }
  const member = parseCheckMemberGroups(result.stdout, groupId);
  if (member === null) {
    deps.logger.verbose("could not read the checkMemberGroups response");
  }
  return member;
}
