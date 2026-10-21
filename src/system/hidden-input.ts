import { createInterface } from "node:readline";

export function createHiddenInput(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): HiddenInput {
  return {
    isTty: Boolean(input.isTTY),

    readHidden(promptText) {
      return new Promise((resolve, reject) => {
        const rl = createInterface({ input, output, terminal: true });
        // readline echoes every keystroke through _writeToOutput. Overriding it to pass
        // only the prompt through is the one way to get a hidden read without taking a
        // dependency or driving raw mode by hand.
        (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = (chunk) => {
          if (chunk.includes(promptText)) {
            output.write(promptText);
          }
        };
        rl.on("close", () => {
          reject(new Error("no input given"));
        });
        rl.question(promptText, (answer) => {
          rl.removeAllListeners("close");
          rl.close();
          output.write("\n");
          resolve(answer);
        });
      });
    }
  };
}

export interface HiddenInput {
  isTty: boolean;
  readHidden(promptText: string): Promise<string>;
}
