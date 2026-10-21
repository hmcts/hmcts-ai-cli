import { describe, expect, it } from "vitest";
import { isNewer } from "./version.js";

describe("isNewer", () => {
  it.each<[string, string, boolean]>([
    ["0.2.0", "0.1.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.1.1", "0.1.0", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
    ["0.10.0", "0.9.0", true],
    ["0.1.10", "0.1.9", true],
    ["1", "0.9.9", true],
    ["1.2", "1.1.9", true],
    ["v1.2.0", "1.1.0", true],
    [" 0.2.0 ", "0.1.0", true],
    ["0.1.0", "0.1.0-rc.1", true],
    ["0.1.0-rc.1", "0.1.0", false],
    ["0.1.0-rc.2", "0.1.0-rc.1", false],
    ["0.2.0+build.5", "0.1.0", true]
  ])("should report %s newer than %s: %s", (candidate, current, expected) => {
    // Act / Assert
    expect(isNewer(candidate, current)).toBe(expected);
  });

  it.each([
    ["an unparseable candidate", "latest", "0.1.0"],
    ["an unparseable current version", "0.2.0", "unknown"],
    ["an empty candidate", "", "0.1.0"]
  ])("should refuse to update on %s", (_name, candidate, current) => {
    // Act / Assert
    expect(isNewer(candidate, current)).toBe(false);
  });
});
