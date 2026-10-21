import { getAzAccessToken } from "../az/token.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Net } from "../system/net.js";
import type { Runner } from "../system/runner.js";

export const DEFAULT_AGENT_HUB_URL = "https://agent-hub.aat.platform.hmcts.net";
export const DEFAULT_AGENT_HUB_SCOPE = "api://dtsse-agent-hub/.default";

const REQUEST_TIMEOUT_MS = 15_000;
const CREDENTIAL_KIND = "bedrock";
const CREDENTIAL_PATH = `/api/agent/credentials/${CREDENTIAL_KIND}`;

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

  const request = async (method: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await token()}` };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return deps.net.fetch(`${baseUrl}${CREDENTIAL_PATH}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  };

  return {
    baseUrl,

    async getBedrockKey() {
      const res = await request("GET");
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`GET ${CREDENTIAL_PATH} failed: ${res.status}`);
      }
      const parsed = (await res.json()) as { value?: unknown };
      return typeof parsed.value === "string" && parsed.value !== "" ? parsed.value : null;
    },

    async putBedrockKey(value) {
      const res = await request("PUT", { value });
      if (!res.ok) {
        throw new Error(`PUT ${CREDENTIAL_PATH} failed: ${res.status}`);
      }
    }
  };
}

export interface AgentHub {
  baseUrl: string;
  getBedrockKey(): Promise<string | null>;
  putBedrockKey(value: string): Promise<void>;
}
