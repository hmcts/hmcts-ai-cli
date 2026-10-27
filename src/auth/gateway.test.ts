import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { GATEWAY_VAULT } from "../az/keyvault.js";
import { STATE_DIR_MODE } from "../system/state-dir.js";
import { API_KEY_HELPER_SCRIPT, HELPER_FILE, HELPER_MODE, prepareGateway, writeApiKeyHelper } from "./gateway.js";

const HOME = "/home/dev";
const STATE = `${HOME}/.local/state/hai`;
const HELPER_PATH = `${STATE}/${HELPER_FILE}`;
const APIM_KEY = "fake-apim-subscription-key";

function respond(argv: string[]) {
  if (argv[1] === "keyvault") {
    return { stdout: `${APIM_KEY}\n` };
  }
  if (argv[0] === "getent") {
    return { code: 0 };
  }
  return undefined;
}

describe("API_KEY_HELPER_SCRIPT", () => {
  it("should be exactly the az token call cath-service uses", () => {
    // Assert
    expect(API_KEY_HELPER_SCRIPT).toContain(
      'az account get-access-token --scope "api://97f4f377-1eda-417b-8367-17c2c64cecd8/.default" --query accessToken -o tsv'
    );
  });

  it("should be a bash script that fails loudly", () => {
    // Assert
    expect(API_KEY_HELPER_SCRIPT.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")).toBe(true);
  });
});

describe("writeApiKeyHelper", () => {
  it("should write the helper 0700 into a 0700 state directory", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    const path = await writeApiKeyHelper(seams);

    // Assert
    expect(path).toBe(HELPER_PATH);
    expect(seams.fs.store.get(HELPER_PATH)).toBe(API_KEY_HELPER_SCRIPT);
    expect(seams.fs.modes.get(HELPER_PATH)).toBe(HELPER_MODE);
    expect(seams.fs.modes.get(STATE)).toBe(STATE_DIR_MODE);
  });

  it("should honour XDG_STATE_HOME", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { XDG_STATE_HOME: "/run/user/1000" } });

    // Act / Assert
    expect(await writeApiKeyHelper(seams)).toBe(`/run/user/1000/hai/${HELPER_FILE}`);
  });
});

describe("prepareGateway", () => {
  it("should read the APIM key and write the helper", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond });

    // Act
    const gateway = await prepareGateway({ seams });

    // Assert
    expect(gateway).toEqual({ apimKey: APIM_KEY, helperPath: HELPER_PATH });
  });

  it("should probe the VPN before it reaches for the private vault", async () => {
    // Arrange
    const order: string[] = [];
    const seams = createFakeSeams({
      env: { HOME },
      respond: (argv) => {
        order.push(argv[0] === "getent" ? "vpn" : `az ${argv[1]}`);
        return respond(argv);
      }
    });

    // Act
    await prepareGateway({ seams });

    // Assert
    expect(order).toEqual(["vpn", "az keyvault"]);
  });

  it("should blame the VPN when the vault is unreachable and the probe says it is down", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      respond: (argv) => (argv[0] === "getent" ? { code: 2 } : { code: 1, stderr: "ERROR: operation timed out" })
    });

    // Act
    const act = prepareGateway({ seams });

    // Assert
    await expect(act).rejects.toThrow(/F5 VPN looks to be down/);
    await expect(act).rejects.toThrow(new RegExp(GATEWAY_VAULT));
  });

  it("should not write the helper when the key could not be read", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: () => ({ code: 1, stderr: "forbidden" }) });

    // Act
    await prepareGateway({ seams }).catch(() => undefined);

    // Assert
    expect(seams.fs.store.has(HELPER_PATH)).toBe(false);
  });
});
