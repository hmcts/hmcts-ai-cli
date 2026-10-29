import { GATEWAY_APIM_KEY_VAR, GATEWAY_VAULT, gatewayApimKeyFromEnv, readGatewayApimKey } from "../az/keyvault.js";
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
  const apimKey = await apimSubscriptionKey(seams);
  const helperPath = await writeApiKeyHelper(seams);
  return { apimKey, helperPath };
}

/**
 * The vault is the default, so the laptop path is unchanged down to the wording of its
 * VPN-down failure. A key handed in through the environment skips the VPN probe as well as
 * the read: the probe only ever existed to explain a vault failure, and there is no vault
 * call left to explain. The key is never logged — only the name of the variable it came
 * from, which is also what `credentialSource` reports as `gateway-apim-env`.
 */
async function apimSubscriptionKey(seams: Seams): Promise<string> {
  const supplied = gatewayApimKeyFromEnv(seams.env);
  if (supplied !== null) {
    seams.logger.verbose(`${GATEWAY_APIM_KEY_VAR} is set, so the APIM subscription key comes from it and ${GATEWAY_VAULT} is not read`);
    return supplied;
  }
  const vpnUp = await probeVpn(seams);
  return await readGatewayApimKey(seams, vpnUp);
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
