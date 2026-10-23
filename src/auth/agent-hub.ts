import { getAzAccessToken } from "../az/token.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Net } from "../system/net.js";
import type { Runner } from "../system/runner.js";

export const DEFAULT_AGENT_HUB_URL = "https://agent-hub.aat.platform.hmcts.net";
export const DEFAULT_AGENT_HUB_SCOPE = "api://dtsse-agent-hub/.default";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The hub's own credential kinds, of which hai asks for two: the Bedrock API key the
 * `bedrock` route uses, and the `claude setup-token` output the `agent-hub` route uses.
 * The hub's `OWNER_READABLE` is `["bedrock", "claude_md", "git_identity"]`, so `claude` is
 * readable only by a virtual agent holding a launch token — an owner asking for it is
 * refused, and the `agent-hub` route fails saying so. Widening that is a change to the hub.
 */
export const CREDENTIAL_KINDS = ["bedrock", "claude"] as const;

const credentialPath = (kind: CredentialKind) => `/api/agent/credentials/${kind}`;

/**
 * agent-hub is reachable from the public internet, so nothing here is gated on the VPN
 * probe. A 404 on the credential means "none stored", not a failure.
 */
export function createAgentHub(deps: { runner: Runner; net: Net; env: Env; clock: Clock }): AgentHub {
  const baseUrl = (deps.env.AGENT_HUB_URL ?? DEFAULT_AGENT_HUB_URL).replace(/\/+$/, "");
  const scope = deps.env.AGENT_HUB_SCOPE ?? DEFAULT_AGENT_HUB_SCOPE;

  let tokenPromise: Promise<string> | null = null;
  const token = () => {
    tokenPromise ??= getAzAccessToken(deps, scope).then((t) => t.token);
    return tokenPromise;
  };

  const request = async (kind: CredentialKind, method: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await token()}` };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return deps.net.fetch(`${baseUrl}${credentialPath(kind)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  };

  return {
    baseUrl,

    async getCredential(kind) {
      const res = await request(kind, "GET");
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`GET ${credentialPath(kind)} failed: ${res.status}`);
      }
      const parsed = (await res.json()) as { value?: unknown };
      return typeof parsed.value === "string" && parsed.value !== "" ? parsed.value : null;
    },

    async putCredential(kind, value) {
      const res = await request(kind, "PUT", { value });
      if (!res.ok) {
        throw new Error(`PUT ${credentialPath(kind)} failed: ${res.status}`);
      }
    }
  };
}

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface AgentHub {
  baseUrl: string;
  getCredential(kind: CredentialKind): Promise<string | null>;
  putCredential(kind: CredentialKind, value: string): Promise<void>;
}
