import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf } from "./__fixtures__/fake-seams.js";
import { main } from "./main.js";

const HOME = "/home/dev";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";

describe("main", () => {
  it("should hand over to claude when everything resolves", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY },
      files: { "/.dockerenv": "" },
      respond: () => ({ code: 0 })
    });

    // Act
    await main(["node", "hai", "-c"], seams);

    // Assert
    expect(seams.runner.execCalls[0]?.argv).toEqual(["claude", "-c"]);
    expect(seams.lines).toEqual([]);
  });

  it("should report a failure on stderr and exit 1", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1" } });

    // Act
    const err = await main(["node", "hai"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain("container mode is not implemented yet");
  });

  it("should redact a secret that reached an error message", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", HAI_ROUTE: "gateway" },
      files: { "/.dockerenv": "" },
      respond: (argv) => (argv[1] === "keyvault" ? { code: 1, stderr: `rejected ${KEY}` } : { code: 0 })
    });

    // Act
    await main(["node", "hai"], seams).catch(() => undefined);

    // Assert
    const said = seams.lines.join("");
    expect(said).not.toContain(KEY);
    expect(said).toContain("[redacted]");
  });

  it("should report a thrown non-Error too", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1" } });
    seams.runner.exec = async () => {
      throw "claude is not installed";
    };
    seams.fs.store.set("/.dockerenv", "");
    seams.env.AWS_BEARER_TOKEN_BEDROCK = KEY;

    // Act
    const err = await main(["node", "hai"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain("claude is not installed");
  });
});
