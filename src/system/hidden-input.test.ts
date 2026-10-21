import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createHiddenInput } from "./hidden-input.js";

const PROMPT = "Paste your Amazon Bedrock API key (input hidden): ";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  return { input, output, written };
}

describe("createHiddenInput", () => {
  it("should report whether stdin is a terminal", () => {
    // Arrange
    const { input, output } = streams();

    // Act / Assert
    expect(createHiddenInput(input, output).isTty).toBe(false);
    expect(createHiddenInput(Object.assign(new PassThrough(), { isTTY: true }), output).isTty).toBe(true);
  });

  it("should read a line without echoing it", async () => {
    // Arrange
    const { input, output, written } = streams();
    const hidden = createHiddenInput(input, output);

    // Act
    const answer = hidden.readHidden(PROMPT);
    input.write("ABSKsecret\n");
    const result = await answer;

    // Assert
    expect(result).toBe("ABSKsecret");
    expect(written.join("")).not.toContain("ABSKsecret");
  });

  it("should still show the prompt", async () => {
    // Arrange
    const { input, output, written } = streams();
    const hidden = createHiddenInput(input, output);

    // Act
    const answer = hidden.readHidden(PROMPT);
    input.write("x\n");
    await answer;

    // Assert
    expect(written.join("")).toContain(PROMPT);
  });

  it("should reject rather than hang when the input ends with nothing typed", async () => {
    // Arrange
    const { input, output } = streams();
    const hidden = createHiddenInput(input, output);

    // Act
    const answer = hidden.readHidden(PROMPT);
    input.end();

    // Assert
    await expect(answer).rejects.toThrow("no input given");
  });

  it("should default to the process streams", () => {
    // Act / Assert — process.stdin is not a terminal under vitest.
    expect(createHiddenInput().isTty).toBe(false);
  });
});
