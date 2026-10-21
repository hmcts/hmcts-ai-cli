import { describe, expect, it } from "vitest";
import { createFakeRunner } from "../__fixtures__/fake-seams.js";
import { probeVpn, VPN_PROBE_HOST } from "./vpn.js";

describe("probeVpn", () => {
  it("should resolve the AAT s2s host with getent on linux", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ stdout: `10.0.0.1 ${VPN_PROBE_HOST}` }));

    // Act
    const result = await probeVpn({ runner, env: {}, platform: "linux" });

    // Assert
    expect(result).toBe(true);
    expect(runner.calls[0]?.argv).toEqual(["getent", "hosts", VPN_PROBE_HOST]);
  });

  it("should report the VPN down when getent cannot resolve", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 2 }));

    // Act / Assert
    expect(await probeVpn({ runner, env: {}, platform: "linux" })).toBe(false);
  });

  it("should use dscacheutil on darwin", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ stdout: "name: host\nip_address: 10.0.0.1\n" }));

    // Act
    const result = await probeVpn({ runner, env: {}, platform: "darwin" });

    // Assert
    expect(result).toBe(true);
    expect(runner.calls[0]?.argv).toEqual(["dscacheutil", "-q", "host", "-a", "name", VPN_PROBE_HOST]);
  });

  it("should read an empty dscacheutil answer as down, because it exits 0 either way", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ stdout: "\n" }));

    // Act / Assert
    expect(await probeVpn({ runner, env: {}, platform: "darwin" })).toBe(false);
  });

  it.each([["HTTPS_PROXY"], ["PROXY_CA_CERT_B64"]])("should skip the probe entirely when %s is set", async (name) => {
    // Arrange
    const runner = createFakeRunner();

    // Act
    const result = await probeVpn({ runner, env: { [name]: "value" }, platform: "linux" });

    // Assert
    expect(result).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("should still probe when the proxy variable is empty", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 0 }));

    // Act
    const result = await probeVpn({ runner, env: { HTTPS_PROXY: "" }, platform: "linux" });

    // Assert
    expect(result).toBe(true);
  });

  it("should never use a shell", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 0 }));

    // Act
    await probeVpn({ runner, env: {}, platform: "linux" });

    // Assert
    expect(runner.calls[0]?.argv[0]).not.toBe("sh");
  });
});
