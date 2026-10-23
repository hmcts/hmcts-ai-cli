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
export function buildClaudeEnv(input: { env: Env; route: Route; bedrockKey?: string; claudeToken?: string; gateway?: Gateway }): Record<string, string> {
  if (input.route === "byol") {
    // Deliberately no Bedrock variables: CLAUDE_CODE_USE_BEDROCK and friends would
    // override the OAuth credential the licence depends on. An exported token is carried
    // over explicitly, though, because container mode hands `claude` only what this
    // function returns: `{}` left a container session on byol using the bind-mounted
    // ~/.claude login instead of the token the engineer exported — a different licence and
    // a different bill. `isSecretEnvKey` holds this name, so it travels on the
    // `docker exec` stdin and never reaches `docker run --env`. In place it is the value
    // the process already had, so repeating it changes nothing.
    const exported = input.env.CLAUDE_CODE_OAUTH_TOKEN;
    return exported === undefined || exported === "" ? {} : { CLAUDE_CODE_OAUTH_TOKEN: exported };
  }

  if (input.route === "agent-hub") {
    // The hub's claude kind is `claude setup-token` output, so it goes in the one variable
    // claude reads a long-lived token from and nowhere else: the Bedrock variables would
    // override it, which is why byol adds none either. Same shape cft-workspace's
    // virtual-agent entrypoint uses.
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
