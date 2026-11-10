import { getAzAccessToken } from "../az/token.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Net } from "../system/net.js";
import type { Runner } from "../system/runner.js";

export const DEFAULT_AGENT_HUB_URL = "https://agent-hub.aat.platform.hmcts.net";
export const DEFAULT_AGENT_HUB_SCOPE = "api://dtsse-agent-hub/.default";

const REQUEST_TIMEOUT_MS = 15_000;

/** The hub credential kind hai asks for: the `agent-hub` route's `claude setup-token` output. */
export const CREDENTIAL_KINDS = ["claude"] as const;

const credentialPath = (kind: CredentialKind) => `/api/agent/credentials/${kind}`;

/** agent-hub is reachable from the public internet, so nothing here is gated on the VPN probe; a 404 means "none stored". */
export function createAgentHub(deps: { runner: Runner; net: Net; env: Env; clock: Clock }): AgentHub {
  const baseUrl = (deps.env.AGENT_HUB_URL ?? DEFAULT_AGENT_HUB_URL).replace(/\/+$/, "");
  const scope = deps.env.AGENT_HUB_SCOPE ?? DEFAULT_AGENT_HUB_SCOPE;

  let tokenPromise: Promise<string> | null = null;
  const token = () => {
    tokenPromise ??= getAzAccessToken(deps, scope).then((t) => t.token);
    return tokenPromise;
  };

  return {
    baseUrl,

    async getCredential(kind) {
      const res = await deps.net.fetch(`${baseUrl}${credentialPath(kind)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${await token()}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`GET ${credentialPath(kind)} failed: ${res.status}`);
      }
      const parsed = (await res.json()) as { value?: unknown };
      return typeof parsed.value === "string" && parsed.value !== "" ? parsed.value : null;
    }
  };
}

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface AgentHub {
  baseUrl: string;
  getCredential(kind: CredentialKind): Promise<string | null>;
}
