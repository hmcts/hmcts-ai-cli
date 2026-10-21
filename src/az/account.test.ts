import { describe, expect, it } from "vitest";
import { createFakeRunner } from "../__fixtures__/fake-seams.js";
import { accountCacheKey, parseAzAccount, readAzAccount } from "./account.js";

const ACCOUNT = { tenantId: "531ff96d-0ae9-462a-8d2d-bec7c0b42082", user: { name: "dev@hmcts.net" } };

describe("parseAzAccount", () => {
  it("should read the tenant and the signed-in user", () => {
    // Act / Assert
    expect(parseAzAccount(JSON.stringify(ACCOUNT))).toEqual({ tenantId: ACCOUNT.tenantId, userId: "dev@hmcts.net" });
  });

  it.each([
    ["unparseable output", "not json"],
    ["no tenant", JSON.stringify({ user: { name: "dev@hmcts.net" } })],
    ["no user", JSON.stringify({ tenantId: ACCOUNT.tenantId })],
    ["an empty user name", JSON.stringify({ tenantId: ACCOUNT.tenantId, user: { name: "" } })],
    ["a non-string tenant", JSON.stringify({ tenantId: 7, user: { name: "dev@hmcts.net" } })],
    ["a non-string user name", JSON.stringify({ tenantId: ACCOUNT.tenantId, user: { name: 7 } })]
  ])("should give up on %s", (_name, stdout) => {
    // Act / Assert
    expect(parseAzAccount(stdout)).toBeNull();
  });
});

describe("readAzAccount", () => {
  it("should ask az who we are", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ stdout: JSON.stringify(ACCOUNT) }));

    // Act
    const result = await readAzAccount({ runner, env: {} });

    // Assert
    expect(result).toEqual({ tenantId: ACCOUNT.tenantId, userId: "dev@hmcts.net" });
    expect(runner.calls[0]?.argv).toEqual(["az", "account", "show", "-o", "json"]);
  });

  it("should settle for not knowing when az cannot say", async () => {
    // Arrange
    const runner = createFakeRunner(() => ({ code: 1, stderr: "not logged in" }));

    // Act / Assert
    expect(await readAzAccount({ runner, env: {} })).toBeNull();
  });
});

describe("accountCacheKey", () => {
  it("should key on the tenant and the user", () => {
    // Act / Assert
    expect(accountCacheKey({ tenantId: "t", userId: "u" })).toBe("t:u");
  });
});
