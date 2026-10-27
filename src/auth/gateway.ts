import { readGatewayApimKey } from "../az/keyvault.js";
import { probeVpn } from "../net/vpn.js";
import type { Fs } from "../system/fs.js";
import type { Seams } from "../system/seams.js";
import { STATE_DIR_MODE, stateDir, statePath } from "../system/state-dir.js";

export const HELPER_FILE = "gateway-token.sh";
export const HELPER_MODE = 0o700;

const GATEWAY_TOKEN_SCOPE = "api://97f4f377-1eda-417b-8367-17c2c64cecd8/.default";

export const API_KEY_HELPER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
exec az account get-access-token --scope "${GATEWAY_TOKEN_SCOPE}" --query accessToken -o tsv
`;

export async function prepareGateway(deps: { seams: Seams }): Promise<Gateway> {
  const { seams } = deps;
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
