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

  it("should wait for about as long as it was asked to", async () => {
    // Arrange
    const before = Date.now();

    // Act
    await createClock().sleep(5);

    // Assert
    expect(Date.now() - before).toBeGreaterThanOrEqual(4);
  });
});
