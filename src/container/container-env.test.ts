import { describe, expect, it } from "vitest";
import { buildClaudeEnv } from "../auth/claude-env.js";
import { ROUTES } from "../auth/route.js";
import { PASSTHROUGH, passthroughEnv, splitEnv } from "./container-env.js";

const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const CLAUDE_TOKEN = "sk-ant-oat01-from-the-hub";

describe("splitEnv", () => {
  it.each(ROUTES)("should put every credential the %s route injects on the secret side", (route) => {
    // Arrange
    const env = buildClaudeEnv({
      env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
      route,
      bedrockKey: BEDROCK_KEY,
      claudeToken: CLAUDE_TOKEN,
      gateway: route === "ai-gateway" ? { apimKey: APIM_KEY, helperPath: "/state/gateway-token.sh" } : undefined
    });

    // Act
    const { open, secret } = splitEnv(env);

    // Assert
    expect(Object.values(open).join(" ")).not.toContain(BEDROCK_KEY);
    expect(Object.values(open).join(" ")).not.toContain(APIM_KEY);
    expect(Object.values(open).join(" ")).not.toContain(CLAUDE_TOKEN);
    expect({ ...open, ...secret }).toEqual(env);
  });

  it.each<[string, string]>([
    ["the Bedrock bearer token", "AWS_BEARER_TOKEN_BEDROCK"],
    ["the claude.ai OAuth token", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["the gateway's APIM header", "ANTHROPIC_CUSTOM_HEADERS"],
    ["an Anthropic API key", "ANTHROPIC_API_KEY"]
  ])("should treat %s as secret", (_name, key) => {
    // Act / Assert
    expect(splitEnv({ [key]: "value" }).secret).toEqual({ [key]: "value" });
  });

  it("should treat the model and region settings as open", () => {
    // Act
    const { open } = splitEnv({ AWS_REGION: "eu-west-2", CLAUDE_CODE_USE_BEDROCK: "1" });

    // Assert
    expect(open).toEqual({ AWS_REGION: "eu-west-2", CLAUDE_CODE_USE_BEDROCK: "1" });
  });
});

describe("passthroughEnv", () => {
  it("should carry over only the names on the list, and only when set", () => {
    // Act
    const env = passthroughEnv({ HAI_VERBOSE: "1", TERM: "xterm-256color", HAI_ROUTE: "", AWS_SECRET_ACCESS_KEY: "nope", PATH: "/usr/bin" });

    // Assert
    expect(env).toEqual({ HAI_VERBOSE: "1", TERM: "xterm-256color" });
  });

  it("should carry no credential-bearing name", () => {
    // Act / Assert
    expect(PASSTHROUGH.filter((name) => /TOKEN|KEY|SECRET|PASSWORD/i.test(name))).toEqual([]);
  });
});
