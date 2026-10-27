import { asProcessEnv, type Env } from "../system/env.js";
import type { Runner } from "../system/runner.js";
import { azFailureHint } from "./token.js";

export const GATEWAY_VAULT = "sps-ai-kv-stg";
export const DEFAULT_GATEWAY_APIM_SECRET = "apim-subscription-dtsse-ai-gateway-bedrock-swe";

const AZ_TIMEOUT_MS = 30_000;

export function gatewayApimSecretName(env: Env): string {
  const override = env.HAI_GATEWAY_APIM_SECRET;
  return override !== undefined && override !== "" ? override : DEFAULT_GATEWAY_APIM_SECRET;
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
