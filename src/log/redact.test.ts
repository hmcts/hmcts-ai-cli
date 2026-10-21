import { describe, expect, it } from "vitest";
import { describeEnv, MASK, redact, redactEnvValue } from "./redact.js";

// Fake, but the right shape for each thing this CLI handles or logs near.
const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const CLAUDE_OAUTH = "sk-ant-oat01-ZmFrZS1jbGF1ZGUtb2F1dGgtdG9rZW4";
const JWT = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJvaWQiOiJmYWtlIn0.c2lnbmF0dXJl";
const GITHUB_PAT = "ghp_0123456789abcdefghijklmnopqrstuvwx";

describe("redact", () => {
  it.each([
    ["a Bedrock bearer token", BEDROCK_KEY],
    ["a claude.ai OAuth token", CLAUDE_OAUTH],
    ["a JWT", JWT],
    ["a GitHub PAT", GITHUB_PAT]
  ])("should mask %s", (_name, secret) => {
    // Act
    const result = redact(`the key is ${secret} and that is that`);

    // Assert
    expect(result).not.toContain(secret);
    expect(result).toContain(MASK);
  });

  it("should mask a private key block", () => {
    // Arrange
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";

    // Act
    const result = redact(`here it is:\n${pem}\n`);

    // Assert
    expect(result).not.toContain("abc");
  });

  it("should mask a storage account key", () => {
    // Act
    const result = redact("DefaultEndpointsProtocol=https;AccountKey=c2VjcmV0Cg==;EndpointSuffix=core");

    // Assert
    expect(result).toContain(`AccountKey=${MASK}`);
    expect(result).not.toContain("c2VjcmV0Cg==");
  });

  it.each([
    ["AWS_BEARER_TOKEN_BEDROCK=", "AWS_BEARER_TOKEN_BEDROCK=not-a-recognised-shape-but-long"],
    ["api_key: ", "api_key: not-a-recognised-shape-but-long"],
    ["password=", "password=not-a-recognised-shape-but-long"],
    ["Ocp-Apim-Subscription-Key: ", "Ocp-Apim-Subscription-Key: not-a-recognised-shape-but-long"]
  ])("should keep the key but mask the value of %s", (prefix, line) => {
    // Act
    const result = redact(line);

    // Assert
    expect(result).toBe(`${prefix}${MASK}`);
  });

  it("should leave text with no secrets alone", () => {
    // Act / Assert
    expect(redact("route bedrock via agent-hub")).toBe("route bedrock via agent-hub");
  });
});

describe("redactEnvValue", () => {
  it.each([
    ["AWS_BEARER_TOKEN_BEDROCK"],
    ["CLAUDE_CODE_OAUTH_TOKEN"],
    ["ANTHROPIC_CUSTOM_HEADERS"],
    ["ANTHROPIC_API_KEY"],
    ["AGENT_HUB_LAUNCH_TOKEN"]
  ])("should mask the whole value of %s whatever shape it is", (name) => {
    // Act / Assert
    expect(redactEnvValue(name, "anything")).toBe(MASK);
  });

  it("should pass a harmless value through", () => {
    // Act / Assert
    expect(redactEnvValue("AWS_REGION", "eu-west-2")).toBe("eu-west-2");
  });

  it("should still redact a secret that turns up in an unexpected variable", () => {
    // Act / Assert
    expect(redactEnvValue("SOME_OTHER_VAR", BEDROCK_KEY)).toBe(MASK);
  });
});

describe("describeEnv", () => {
  it("should sort the variables and mask the secret ones", () => {
    // Act
    const lines = describeEnv({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY, AWS_REGION: "eu-west-2" });

    // Assert
    expect(lines).toEqual([`AWS_BEARER_TOKEN_BEDROCK=${MASK}`, "AWS_REGION=eu-west-2", "CLAUDE_CODE_USE_BEDROCK=1"]);
  });
});
