import { describe, expect, it } from "vitest";
import { createFakeRunner, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { azFailureHint, getAzAccessToken, parseAzToken } from "./token.js";

const SCOPE = "api://dtsse-agent-hub/.default";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJvaWQiOiJmYWtlIn0.c2ln";

const deps = (respond: Parameters<typeof createFakeRunner>[0]) => ({
  runner: createFakeRunner(respond),
  env: { PATH: "/usr/bin" },
  clock: { now: () => FIXED_NOW }
});

describe("parseAzToken", () => {
  it("should read the expiry out of expires_on as epoch seconds", () => {
    // Arrange
    const stdout = JSON.stringify({ accessToken: TOKEN, expires_on: 1800000000 });

    // Act
    const result = parseAzToken(stdout, FIXED_NOW);

    // Assert
    expect(result).toEqual({ token: TOKEN, expiresAt: 1800000000000 });
  });

  it("should read the expiry out of expiresOn as a date string", () => {
    // Arrange
    const stdout = JSON.stringify({ accessToken: TOKEN, expiresOn: "2026-10-21T10:00:00Z" });

    // Act
    const result = parseAzToken(stdout, FIXED_NOW);

    // Assert
    expect(result.expiresAt).toBe(Date.parse("2026-10-21T10:00:00Z"));
  });

  it("should prefer expires_on when az sends both", () => {
    // Arrange
    const stdout = JSON.stringify({ accessToken: TOKEN, expires_on: 1800000000, expiresOn: "2026-10-21T10:00:00Z" });

    // Act
    const result = parseAzToken(stdout, FIXED_NOW);

    // Assert
    expect(result.expiresAt).toBe(1800000000000);
  });

  it.each([
    ["neither field", { accessToken: TOKEN }],
    ["an unparseable expiresOn", { accessToken: TOKEN, expiresOn: "not a date" }],
    ["a non-numeric expires_on", { accessToken: TOKEN, expires_on: "soon" }]
  ])("should fall back to a short lifetime given %s", (_name, payload) => {
    // Act
    const result = parseAzToken(JSON.stringify(payload), FIXED_NOW);

    // Assert
    expect(result.expiresAt).toBe(FIXED_NOW + 30 * 60 * 1000);
  });

  it.each([
    ["no accessToken", {}],
    ["an empty accessToken", { accessToken: "" }]
  ])("should refuse a response with %s", (_name, payload) => {
    // Act / Assert
    expect(() => parseAzToken(JSON.stringify(payload), FIXED_NOW)).toThrow("no accessToken");
  });
});

describe("getAzAccessToken", () => {
  it("should ask az for the scope and return the token", async () => {
    // Arrange
    const d = deps(() => ({ stdout: JSON.stringify({ accessToken: TOKEN, expires_on: 1800000000 }) }));

    // Act
    const result = await getAzAccessToken(d, SCOPE);

    // Assert
    expect(result.token).toBe(TOKEN);
    expect(d.runner.calls[0]?.argv).toEqual(["az", "account", "get-access-token", "--scope", SCOPE, "-o", "json"]);
  });

  it("should pass the environment through rather than inherit it implicitly", async () => {
    // Arrange
    const d = deps(() => ({ stdout: JSON.stringify({ accessToken: TOKEN }) }));

    // Act
    await getAzAccessToken(d, SCOPE);

    // Assert
    expect(d.runner.calls[0]?.opts.env).toEqual({ PATH: "/usr/bin" });
  });

  it("should report what az said when it fails", async () => {
    // Arrange
    const d = deps(() => ({ code: 1, stderr: "ERROR: Please run 'az login'\nmore detail" }));

    // Act / Assert
    await expect(getAzAccessToken(d, SCOPE)).rejects.toThrow("ERROR: Please run 'az login'");
  });

  it("should report an unreadable response without echoing it", async () => {
    // Arrange
    const d = deps(() => ({ stdout: "not json" }));

    // Act / Assert
    await expect(getAzAccessToken(d, SCOPE)).rejects.toThrow("could not read the token az returned");
  });
});

describe("azFailureHint", () => {
  it("should take the first line only", () => {
    // Act / Assert
    expect(azFailureHint("first\nsecond")).toBe("first");
  });

  it("should suggest az login when az said nothing at all", () => {
    // Act / Assert
    expect(azFailureHint("   ")).toContain("az login");
  });

  it("should redact a secret that leaked into stderr", () => {
    // Act
    const result = azFailureHint("failed for ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw");

    // Assert
    expect(result).toBe("failed for [redacted]");
  });
});
