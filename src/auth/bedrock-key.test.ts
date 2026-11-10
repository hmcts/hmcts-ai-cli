import { describe, expect, it } from "vitest";
import { createFakeHiddenInput, createFakeSeams } from "../__fixtures__/fake-seams.js";
import { canPrompt, resolveBedrockKey } from "./bedrock-key.js";

const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const TYPED = "ABSKVHlwZWQtYnktaGFuZC0wMDAwMDAwMDAwMDA";

describe("canPrompt", () => {
  it("should prompt a person at a terminal", () => {
    // Act / Assert
    expect(canPrompt(createFakeSeams())).toBe(true);
  });

  it("should not prompt when stdin is not a terminal", () => {
    // Arrange
    const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([], false) });

    // Act / Assert
    expect(canPrompt(seams)).toBe(false);
  });

  it("should not prompt a virtual agent, whose pane nobody is watching", () => {
    // Arrange
    const seams = createFakeSeams({ env: { AGENT_HUB_LAUNCH_TOKEN: "launch-token" } });

    // Act / Assert
    expect(canPrompt(seams)).toBe(false);
  });
});

describe("resolveBedrockKey", () => {
  it("should use the key already in the environment and ask nobody", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { AWS_BEARER_TOKEN_BEDROCK: KEY }, hiddenInput: createFakeHiddenInput([], false) });

    // Act / Assert
    expect(await resolveBedrockKey({ seams })).toBe(KEY);
  });

  describe("no key in the environment", () => {
    it("should prompt for one", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });

      // Act
      const key = await resolveBedrockKey({ seams });

      // Assert
      expect(key).toBe(TYPED);
    });

    it("should say why it is asking", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });

      // Act
      await resolveBedrockKey({ seams });

      // Assert
      const said = seams.lines.join("");
      expect(said).toContain("No Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK");
    });

    it("should fail fast rather than block on a pipe nobody is typing into", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([], false) });

      // Act / Assert
      await expect(resolveBedrockKey({ seams })).rejects.toThrow("stdin is not a terminal");
    });

    it("should refuse an empty key", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput(["   "]) });

      // Act / Assert
      await expect(resolveBedrockKey({ seams })).rejects.toThrow("no Amazon Bedrock API key entered");
    });

    it("should trim what was pasted", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([` ${TYPED} \n`]) });

      // Act / Assert
      expect(await resolveBedrockKey({ seams })).toBe(TYPED);
    });
  });

  it("should never log the key itself", async () => {
    // Arrange
    const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });

    // Act
    await resolveBedrockKey({ seams });

    // Assert
    expect(seams.lines.join("")).not.toContain(TYPED);
  });
});
