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
 * The variables each route has to *remove* from the environment it hands over, rather than
 * merely not set. The handover is `{ ...process.env, ...buildClaudeEnv(...) }`, so a
 * `CLAUDE_CODE_USE_BEDROCK=1` left in a shell profile, or baked into the devcontainer
 * image, survived into a `byol` session: hai printed "paid for by your own Claude licence"
 * and ran the session on Bedrock. Now that an explicit route is obeyed and that line is the
 * only safeguard left, the environment handed over must only be able to mean one payer.
 *
 * Each route drops the credential and transport variables belonging to the *other* payers,
 * and never one it sets itself — `conflictingEnv` and `buildClaudeEnv` are disjoint per
 * route, which is asserted. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` go on every
 * route: no route of hai's uses them, and either would quietly take precedence over the one
 * that pays. cft-workspace's virtual-agent entrypoint unsets the same two on both branches.
 *
 * **A base URL is a routing fact, not a tuning knob.** Clearing `ANTHROPIC_CUSTOM_HEADERS`
 * without `ANTHROPIC_BEDROCK_BASE_URL` turned a misroute into an unexplained 401: a shell
 * carrying cft-workspace's old gateway quadruple, running an explicit `bedrock`, lost the
 * APIM key and the skip-auth flag and kept a base URL pointing at the gateway, so every
 * request reached APIM unauthenticated. So each route clears the base URLs it does not set
 * itself, and `ANTHROPIC_BASE_URL` on all four, since none of them uses it and an inherited
 * one would send a personal OAuth token to a third-party endpoint.
 *
 * The one route that keeps an engineer's own is `ai-gateway`, which *sets*
 * `ANTHROPIC_BEDROCK_BASE_URL` through `existingOr` — that is the only way to point a route
 * at a custom endpoint, and it is deliberate that there is exactly one: nothing in the
 * environment distinguishes a base URL set on purpose for this session from one a previous
 * route left behind, so the route that owns the variable is the only place the question can
 * be answered. A direct-Bedrock proxy therefore cannot be expressed today; that wants an
 * `HAI_*` variable of its own rather than a silently honoured leftover.
 *
 * Genuine tuning knobs the engineer is allowed to win on — `AWS_REGION` and the model
 * names — are deliberately not here.
 */
export const CONFLICTING_ENV: Record<Route, readonly string[]> = {
  // The Bedrock switch, key and gateway transport, plus both base URLs: every one of them
  // would override or misroute the OAuth credential a personal licence depends on.
  "agent-hub": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_USE_BEDROCK"
  ],
  byol: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_USE_BEDROCK"
  ],
  // The gateway authenticates for us, so a bearer token is not its credential and a
  // personal token is a different payer entirely. Its own base URL is absent here because
  // it sets one, which is what lets an engineer point this route somewhere else.
  "ai-gateway": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN"],
  // Skip-bedrock-auth would stop claude signing with the bearer token this route is for; a
  // stale APIM header and base URL together send a Bedrock-keyed session to the gateway,
  // and the base URL alone sends it there with no key at all.
  bedrock: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH"
  ]
};

/** Pure over the route alone, so container mode can forward the names and the entrypoint unset them. */
export function conflictingEnv(route: Route): readonly string[] {
  return CONFLICTING_ENV[route];
}

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
