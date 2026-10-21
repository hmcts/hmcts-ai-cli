import { describe, expect, it } from "vitest";
import { asProcessEnv, createEnv, isEnabled, isSet } from "./env.js";

describe("createEnv", () => {
  it("should take a copy of the process environment, so a later mutation is invisible", () => {
    // Arrange
    const env = createEnv();

    // Act
    process.env.HAI_ENV_TEST_MARKER = "1";

    // Assert
    expect(env.HAI_ENV_TEST_MARKER).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    delete process.env.HAI_ENV_TEST_MARKER;
  });
});

describe("isEnabled", () => {
  it.each<[string | undefined, boolean]>([
    ["1", true],
    ["0", false],
    ["true", false],
    ["", false],
    [undefined, false]
  ])("should read %s as enabled: %s", (value, expected) => {
    // Act / Assert
    expect(isEnabled({ FLAG: value }, "FLAG")).toBe(expected);
  });
});

describe("isSet", () => {
  it.each<[string | undefined, boolean]>([
    ["1", true],
    ["anything", true],
    ["", false],
    [undefined, false]
  ])("should read %s as set: %s", (value, expected) => {
    // Act / Assert
    expect(isSet({ FLAG: value }, "FLAG")).toBe(expected);
  });
});

describe("asProcessEnv", () => {
  it("should drop the unset variables, which a child cannot be handed", () => {
    // Act
    const result = asProcessEnv({ SET: "yes", EMPTY: "", UNSET: undefined });

    // Assert
    expect(result).toEqual({ SET: "yes", EMPTY: "" });
  });
});
