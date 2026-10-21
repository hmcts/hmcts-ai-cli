import { readGatewayApimKey } from "../az/keyvault.js";
import { probeVpn } from "../net/vpn.js";
import type { Fs } from "../system/fs.js";
import type { Seams } from "../system/seams.js";
import { STATE_DIR_MODE, stateDir, statePath } from "../system/state-dir.js";

export const HELPER_FILE = "gateway-token.sh";
export const HELPER_MODE = 0o700;

const GATEWAY_TOKEN_SCOPE = "api://b3bfa0f5-faa5-4d10-bba0-e284144aea89/.default";

export const RATE_LIMIT_NOTICE =
  "the AI Gateway APIM subscription is rate-limited to 30 requests/minute and 1000/day, shared across everyone using that key — a busy session can exhaust it";

export const API_KEY_HELPER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
exec az account get-access-token --scope "${GATEWAY_TOKEN_SCOPE}" --query accessToken -o tsv
`;

export async function prepareGateway(deps: { seams: Seams }): Promise<Gateway> {
  const { seams } = deps;
  seams.logger.once("gateway-rate-limit", RATE_LIMIT_NOTICE);
  const vpnUp = await probeVpn(seams);
  const apimKey = await readGatewayApimKey(seams, vpnUp);
  const helperPath = await writeApiKeyHelper(seams);
  return { apimKey, helperPath };
}

export async function writeApiKeyHelper(deps: { fs: Fs; env: Seams["env"] }): Promise<string> {
  const path = statePath(deps.env, HELPER_FILE);
  await deps.fs.mkdirp(stateDir(deps.env), { mode: STATE_DIR_MODE });
  await deps.fs.writeText(path, API_KEY_HELPER_SCRIPT, { mode: HELPER_MODE });
  return path;
}

export interface Gateway {
  apimKey: string;
  helperPath: string;
}
