import { asProcessEnv, type Env } from "../system/env.js";
import type { Runner } from "../system/runner.js";
import { azFailureHint } from "./token.js";

export const GATEWAY_VAULT = "sps-ai-kv-stg";
export const DEFAULT_GATEWAY_APIM_SECRET = "apim-subscription-dtsse-ai-gateway-bedrock-swe";
export const GATEWAY_APIM_KEY_VAR = "HAI_GATEWAY_APIM_KEY";

const AZ_TIMEOUT_MS = 30_000;

export function gatewayApimSecretName(env: Env): string {
  const override = env.HAI_GATEWAY_APIM_SECRET;
  return override !== undefined && override !== "" ? override : DEFAULT_GATEWAY_APIM_SECRET;
}

/**
 * The key itself, for a caller that cannot reach the vault at all: `sps-ai-kv-stg` has
 * `publicNetworkAccess: Disabled` and its only private endpoint is in `sps-ai-vnet-stg`,
 * so a pod in a CFT AKS cluster can never read it however well it is authenticated, while
 * a laptop on the F5 VPN can. `HAI_GATEWAY_APIM_SECRET` renames the secret and still ends
 * at that read; this replaces the read, and is the one way to hand hai a key it does not
 * have to go and get. Everything else about the gateway — the staging host, the audience,
 * the vault — stays hai's to decide, so a caller that holds the key duplicates none of it.
 *
 * Trimmed, and blank is "not set" rather than a deliberately empty key: the value arrives
 * through a Helm template or a container env file, where an absent source renders as an
 * empty string, and an empty subscription key would otherwise reach APIM as a 401 with
 * nothing saying hai had been handed nothing.
 */
export function gatewayApimKeyFromEnv(env: Env): string | null {
  const supplied = env[GATEWAY_APIM_KEY_VAR]?.trim();
  return supplied === undefined || supplied === "" ? null : supplied;
}

/**
 * sps-ai-kv-stg has no public endpoint, so this is the one call in the whole CLI that
 * genuinely needs the F5 VPN. `vpnUp` is only consulted to explain a failure.
 */
export async function readGatewayApimKey(deps: { runner: Runner; env: Env }, vpnUp: boolean | null): Promise<string> {
  const secretName = gatewayApimSecretName(deps.env);
  const result = await deps.runner.run(
    ["az", "keyvault", "secret", "show", "--vault-name", GATEWAY_VAULT, "--name", secretName, "--query", "value", "-o", "tsv"],
    {
      env: asProcessEnv(deps.env),
      timeoutMs: AZ_TIMEOUT_MS
    }
  );
  const key = result.stdout.trim();
  if (result.code === 0 && key !== "") {
    return key;
  }
  const hint = result.code === 0 ? "it came back empty" : azFailureHint(result.stderr);
  if (vpnUp === false) {
    throw new Error(
      `could not read the AI Gateway APIM key from ${GATEWAY_VAULT}: ${hint}. That vault is private and the F5 VPN looks to be down — connect it and try again.`
    );
  }
  throw new Error(`could not read the AI Gateway APIM key (${secretName}) from ${GATEWAY_VAULT}: ${hint}`);
}
