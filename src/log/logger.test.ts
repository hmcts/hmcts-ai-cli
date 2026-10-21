import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function capture(isVerbose = false) {
  const lines: string[] = [];
  return { lines, logger: createLogger({ write: (text) => lines.push(text), isVerbose }) };
}

describe("createLogger", () => {
  it("should prefix and terminate every line", () => {
    // Arrange
    const { lines, logger } = capture();

    // Act
    logger.say("something happened");

    // Assert
    expect(lines).toEqual(["hai: something happened\n"]);
  });

  it("should redact a secret on its way out", () => {
    // Arrange
    const { lines, logger } = capture();

    // Act
    logger.say("key ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw rejected");

    // Assert
    expect(lines[0]).toBe("hai: key [redacted] rejected\n");
  });

  it("should swallow a verbose line when verbosity is off", () => {
    // Arrange
    const { lines, logger } = capture(false);

    // Act
    logger.verbose("detail");

    // Assert
    expect(lines).toEqual([]);
  });

  it("should emit a verbose line when verbosity is on", () => {
    // Arrange
    const { lines, logger } = capture(true);

    // Act
    logger.verbose("detail");

    // Assert
    expect(lines).toEqual(["hai: detail\n"]);
  });

  it("should say a once-keyed message only the first time", () => {
    // Arrange
    const { lines, logger } = capture();

    // Act
    logger.once("rate-limit", "mind the rate limit");
    logger.once("rate-limit", "mind the rate limit");

    // Assert
    expect(lines).toHaveLength(1);
  });
});
