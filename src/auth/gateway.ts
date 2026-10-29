import { GATEWAY_APIM_KEY_VAR, GATEWAY_VAULT, gatewayApimKeyFromEnv, readGatewayApimKey } from "../az/keyvault.js";
import { probeVpn } from "../net/vpn.js";
import type { Fs } from "../system/fs.js";
import type { Seams } from "../system/seams.js";
import { STATE_DIR_MODE, stateDir, statePath } from "../system/state-dir.js";

export const HELPER_FILE = "gateway-token.sh";
export const HELPER_MODE = 0o700;

/**
 * The path of the `apiKeyHelper` hai gave `claude`, exported into the session so a tool the
 * session starts can authenticate the same way the session does. `claude --settings` keeps only
 * the last one it is given, so anything spawning its own `claude` has to name the helper itself,
 * and the alternative is restating hai's state-directory layout somewhere else — the drift that
 * put one agent-hub pod on the sandbox gateway when the hub held its own copy of the host and the
 * audience. Only the `ai-gateway` route has a helper, so only that route sets it, and every other
 * route clears an inherited one: a personal route is an OAuth login, and a helper minting an Entra
 * token would be sent to api.anthropic.com instead.
 */
export const API_KEY_HELPER_VAR = "HAI_API_KEY_HELPER";

/** Nothing to publish on a route with no helper, which is every route but the gateway. */
export function apiKeyHelperEnv(helperPath: string | undefined): Record<string, string> {
  return helperPath === undefined ? {} : { [API_KEY_HELPER_VAR]: helperPath };
}

/**
 * Where the container entrypoint installs the helper. The host's state directory is not the
 * container's, and `runtime/entrypoint.sh` installs it under `$HOME` there, so this derives the
 * path from the container's home alone — an `XDG_STATE_HOME` of ours or the image's would move
 * this answer away from the one place the file actually is.
 */
export function containerHelperPath(containerHome: string): string {
  return statePath({ HOME: containerHome }, HELPER_FILE);
}

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
