import type { Env } from "../system/env.js";
import { API_KEY_HELPER_VAR, type Gateway } from "./gateway.js";
import type { Route } from "./route.js";

export const DEFAULT_AWS_REGION = "eu-west-2";

export const DEFAULT_MODELS: Record<string, string> = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku-5-5",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "eu.anthropic.claude-opus-5-5[1m]",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "eu.anthropic.claude-sonnet-5-5[1m]"
};

export const GATEWAY_BEDROCK_BASE_URL = "https://ai-gateway.staging.platform.hmcts.net/ai/platform/v1/bedrock";

const API_KEY_HELPER_TTL_MS = "300000";

/**
 * The variables each route must *remove* rather than merely not set: the handover is
 * `{ ...process.env, ...buildClaudeEnv(...) }`, so an inherited one would decide who pays.
 * Each route clears the base URLs it does not set itself, because the URL is what routes, and
 * every route but the gateway clears `API_KEY_HELPER_VAR`, which the gateway alone publishes.
 */
export const CONFLICTING_ENV: Record<Route, readonly string[]> = {
  "agent-hub": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_USE_BEDROCK",
    API_KEY_HELPER_VAR
  ],
  byol: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_USE_BEDROCK",
    API_KEY_HELPER_VAR
  ],
  "ai-gateway": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN"],
  bedrock: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    API_KEY_HELPER_VAR
  ]
};

/** Pure over the route alone, so container mode can forward the names and the entrypoint unset them. */
export function conflictingEnv(route: Route): readonly string[] {
  return CONFLICTING_ENV[route];
}

/**
 * The variables to add to the environment `claude` is launched with, not the whole
 * environment. Anything the engineer already set wins.
 */
export function buildClaudeEnv(input: { env: Env; route: Route; bedrockKey?: string; claudeToken?: string; gateway?: Gateway }): Record<string, string> {
  if (input.route === "byol") {
    // An exported token is carried over because container mode hands `claude` only what
    // this function returns.
    const exported = input.env.CLAUDE_CODE_OAUTH_TOKEN;
    return exported === undefined || exported === "" ? {} : { CLAUDE_CODE_OAUTH_TOKEN: exported };
  }

  if (input.route === "agent-hub") {
    if (input.claudeToken === undefined) {
      throw new Error("the agent-hub route needs the Claude token agent-hub holds for you");
    }
    return { CLAUDE_CODE_OAUTH_TOKEN: input.claudeToken };
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
    throw new Error("the ai-gateway route needs an APIM subscription key");
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
