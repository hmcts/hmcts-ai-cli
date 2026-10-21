import type { Env } from "../system/env.js";
import type { Gateway } from "./gateway.js";
import type { Route } from "./route.js";

export const DEFAULT_AWS_REGION = "eu-west-2";

export const DEFAULT_MODELS: Record<string, string> = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku-5-5",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "eu.anthropic.claude-opus-5-5[1m]",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "eu.anthropic.claude-sonnet-5-5[1m]"
};

export const GATEWAY_BEDROCK_BASE_URL = "https://ai-gateway.sandbox.platform.hmcts.net/ai/platform/v1/bedrock";

const API_KEY_HELPER_TTL_MS = "300000";

/**
 * The variables to add to the environment `claude` is launched with, not the whole
 * environment, so a test can assert exactly what a route injects. Anything the engineer
 * already set wins, matching run.sh's `${VAR:-default}` form.
 */
export function buildClaudeEnv(input: { env: Env; route: Route; bedrockKey?: string; gateway?: Gateway }): Record<string, string> {
  if (input.route === "own-licence") {
    // Deliberately empty: CLAUDE_CODE_USE_BEDROCK and friends would override the OAuth
    // credential the licence depends on.
    return {};
  }

  const added: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: existingOr(input.env, "AWS_REGION", DEFAULT_AWS_REGION)
  };
  for (const [name, model] of Object.entries(DEFAULT_MODELS)) {
    added[name] = existingOr(input.env, name, model);
  }

  if (input.route === "bedrock") {
    if (input.bedrockKey === undefined) {
      throw new Error("the bedrock route needs a Bedrock API key");
    }
    added.AWS_BEARER_TOKEN_BEDROCK = input.bedrockKey;
    return added;
  }

  if (input.gateway === undefined) {
    throw new Error("the gateway route needs an APIM subscription key");
  }
  added.CLAUDE_CODE_SKIP_BEDROCK_AUTH = "1";
  added.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = API_KEY_HELPER_TTL_MS;
  added.ANTHROPIC_BEDROCK_BASE_URL = existingOr(input.env, "ANTHROPIC_BEDROCK_BASE_URL", GATEWAY_BEDROCK_BASE_URL);
  added.ANTHROPIC_CUSTOM_HEADERS = `Ocp-Apim-Subscription-Key: ${input.gateway.apimKey}`;
  return added;
}

function existingOr(env: Env, name: string, fallback: string): string {
  const existing = env[name];
  return existing !== undefined && existing !== "" ? existing : fallback;
}
