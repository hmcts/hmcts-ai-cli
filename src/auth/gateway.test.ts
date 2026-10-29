import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { GATEWAY_VAULT } from "../az/keyvault.js";
import { STATE_DIR_MODE } from "../system/state-dir.js";
import { API_KEY_HELPER_SCRIPT, HELPER_FILE, HELPER_MODE, prepareGateway, writeApiKeyHelper } from "./gateway.js";

const HOME = "/home/dev";
const STATE = `${HOME}/.local/state/hai`;
const HELPER_PATH = `${STATE}/${HELPER_FILE}`;
const APIM_KEY = "fake-apim-subscription-key";
/** Distinct from APIM_KEY, so a row proves which of the two sources was taken. */
const HANDED_IN_KEY = "fake-apim-key-handed-in-by-the-caller";

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

  it("should take the key from the environment and reach for no vault when HAI_GATEWAY_APIM_KEY is set", async () => {
    // Arrange — nothing is scripted, so any process launched at all fails the run: the
    // point of the variable is a caller that cannot reach sps-ai-kv-stg from where it is.
    const seams = createFakeSeams({ env: { HOME, HAI_GATEWAY_APIM_KEY: HANDED_IN_KEY } });

    // Act
    const gateway = await prepareGateway({ seams });

    // Assert
    expect(gateway).toEqual({ apimKey: HANDED_IN_KEY, helperPath: HELPER_PATH });
    expect(seams.runner.calls).toEqual([]);
  });

  it("should trim the key when HAI_GATEWAY_APIM_KEY arrives with a trailing newline", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_GATEWAY_APIM_KEY: `${HANDED_IN_KEY}\n` } });

    // Act
    const gateway = await prepareGateway({ seams });

    // Assert — the key goes into an `Ocp-Apim-Subscription-Key` header, where a newline is
    // not something APIM forgives.
    expect(gateway.apimKey).toBe(HANDED_IN_KEY);
  });

  it("should read the vault when HAI_GATEWAY_APIM_KEY is empty", async () => {
    // Arrange — a Helm value whose source was missing renders as an empty string, and that
    // has to read as "not set" rather than as an empty subscription key.
    const seams = createFakeSeams({ env: { HOME, HAI_GATEWAY_APIM_KEY: "" }, respond });

    // Act
    const gateway = await prepareGateway({ seams });

    // Assert
    expect(gateway.apimKey).toBe(APIM_KEY);
    expect(seams.runner.calls.map((call) => call.argv[1])).toContain("keyvault");
  });

  it("should keep the key out of the log when it came from the environment", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1", HAI_GATEWAY_APIM_KEY: HANDED_IN_KEY } });

    // Act
    await prepareGateway({ seams });

    // Assert — the variable is named so the vault read's absence is explicable; its value
    // is not, and `isSecretEnvKey` holds the same name for the same reason.
    expect(seams.lines.join("")).toContain("HAI_GATEWAY_APIM_KEY is set");
    expect(seams.lines.join("")).not.toContain(HANDED_IN_KEY);
  });
});
