import { describe, expect, it } from "vitest";
import { createFakeRunner } from "../__fixtures__/fake-seams.js";
import { DEFAULT_GATEWAY_APIM_SECRET, GATEWAY_VAULT, gatewayApimSecretName, readGatewayApimKey } from "./keyvault.js";

const APIM_KEY = "fake-apim-subscription-key";

describe("gatewayApimSecretName", () => {
  it("should default to the DTSSE Bedrock subscription secret", () => {
    // Act / Assert
    expect(gatewayApimSecretName({})).toBe(DEFAULT_GATEWAY_APIM_SECRET);
  });

  it.each([
    ["an override", { HAI_GATEWAY_APIM_SECRET: "other-secret" }, "other-secret"],
    ["an empty override", { HAI_GATEWAY_APIM_SECRET: "" }, DEFAULT_GATEWAY_APIM_SECRET]
  ])("should honour %s", (_name, env, expected) => {
    // Act / Assert
    expect(gatewayApimSecretName(env)).toBe(expected);
  });
});

describe("readGatewayApimKey", () => {
  it("should read the secret from the sandbox vault and trim it", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ stdout: `${APIM_KEY}\n` }));

    // Act
    const key = await readGatewayApimKey({ runner, env: {} }, true);

    // Assert
    expect(key).toBe(APIM_KEY);
    expect(runner.calls[0]?.argv).toEqual([
      "az",
      "keyvault",
      "secret",
      "show",
      "--vault-name",
      GATEWAY_VAULT,
      "--name",
      DEFAULT_GATEWAY_APIM_SECRET,
      "--query",
      "value",
      "-o",
      "tsv"
    ]);
  });

  it("should blame the VPN when the probe found it down", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 1, stderr: "ERROR: operation timed out" }));

    // Act / Assert
    await expect(readGatewayApimKey({ runner, env: {} }, false)).rejects.toThrow("F5 VPN looks to be down");
  });

  it.each([
    ["the VPN looks up", true],
    ["the VPN was not probed", null]
  ])("should report what az said when %s", async (_name, vpnUp) => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 1, stderr: "ERROR: Forbidden" }));

    // Act
    const act = readGatewayApimKey({ runner, env: {} }, vpnUp);

    // Assert
    await expect(act).rejects.toThrow("ERROR: Forbidden");
    await expect(act).rejects.not.toThrow("F5 VPN looks to be down");
  });

  it("should refuse an empty secret", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ stdout: "\n" }));

    // Act / Assert
    await expect(readGatewayApimKey({ runner, env: {} }, true)).rejects.toThrow("it came back empty");
  });

  it("should name the overridden secret in its failure", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 1, stderr: "nope" }));

    // Act / Assert
    await expect(readGatewayApimKey({ runner, env: { HAI_GATEWAY_APIM_SECRET: "other-secret" } }, true)).rejects.toThrow("other-secret");
  });
});
