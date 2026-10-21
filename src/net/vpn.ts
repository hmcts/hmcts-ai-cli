import type { Env } from "../system/env.js";
import { isSet } from "../system/env.js";
import type { Runner } from "../system/runner.js";

/** AAT s2s: a private-DNS name that resolves only while the F5 VPN is up. */
export const VPN_PROBE_HOST = "rpe-service-auth-provider-aat.service.core-compute-aat.internal";

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Informational only: a VPN that looks down never blocks a launch, it just lets an error
 * message name the likely cause. Null means "not probed".
 */
export async function probeVpn(deps: { runner: Runner; env: Env; platform: string }): Promise<boolean | null> {
  // Behind an egress proxy the traffic never touches our resolver, so a DNS answer says
  // nothing about whether the VPN is up.
  if (isSet(deps.env, "HTTPS_PROXY") || isSet(deps.env, "PROXY_CA_CERT_B64")) {
    return null;
  }
  const argv =
    deps.platform === "darwin"
      ? // dscacheutil goes through the system resolver, which is where the VPN's split DNS sits.
        ["dscacheutil", "-q", "host", "-a", "name", VPN_PROBE_HOST]
      : ["getent", "hosts", VPN_PROBE_HOST];
  const result = await deps.runner.run(argv, { timeoutMs: PROBE_TIMEOUT_MS });
  if (result.code !== 0) {
    return false;
  }
  // dscacheutil exits 0 whether or not it found anything, so the answer is in its output.
  return deps.platform === "darwin" ? result.stdout.includes("ip_address") : true;
}
