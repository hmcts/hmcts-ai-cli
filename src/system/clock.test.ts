import { describe, expect, it } from "vitest";
import { createClock } from "./clock.js";

describe("createClock", () => {
  it("should report the wall clock", () => {
    // Arrange
    const before = Date.now();

    // Act
    const now = createClock().now();

    // Assert
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
