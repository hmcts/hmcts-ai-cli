import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf } from "./__fixtures__/fake-seams.js";
import { hairMain, main, sbxMain } from "./main.js";

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
    expect(seams.runner.execCalls[0]?.argv.at(-1)).toBe("-c");
    expect(seams.runner.execCalls[0]?.argv[0]).toBe("claude");
    expect(seams.lines).toEqual(["hai: route bedrock — paid for by HMCTS, through Amazon Bedrock\n"]);
  });

  it("should report a failure on stderr and exit 1", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY, HAI_MOUNTS: "nonsense" },
      respond: () => ({ code: 0 })
    });

    // Act
    const err = await main(["node", "hai"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain('HAI_MOUNTS entry "nonsense" is not source:target');
  });

  it("should redact a secret that reached an error message", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", HAI_ROUTE: "ai-gateway" },
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

  it("should hand over to a sandbox from sbxMain", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY },
      cwd: "/work",
      respond: (argv) => {
        if (argv[0] === "sbx" && argv[1] === "version") {
          return { code: 0, stdout: JSON.stringify({ client: { version: "v1" }, server: { version: "v1", state: "running" } }) };
        }
        return { code: 0, stdout: argv[1] === "rev-parse" ? "/work\n" : "" };
      }
    });

    // Act
    await sbxMain(["node", "sbx-hai", "-c"], seams).catch(() => undefined);

    // Assert
    expect(seams.runner.interactiveCalls[0]?.argv.slice(0, 2)).toEqual(["sbx", "run"]);
    expect(seams.runner.interactiveCalls[0]?.argv.slice(-2)).toEqual(["--", "-c"]);
  });

  it("should report an sbx failure on stderr and exit 1", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1" }, files: { "/.dockerenv": "" } });

    // Act
    const err = await sbxMain(["node", "sbx-hai"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain("sbx-hai runs on the host, not inside a container");
  });

  it("should report a hair failure on stderr and exit 1", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1", HAI_MOUNTS: "nonsense" }, respond: () => ({ code: 0 }) });

    // Act
    const err = await hairMain(["node", "hair"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).not.toEqual("");
  });

  it("should exit 0 from a hook whatever the payload was, a hook never breaking a session", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, stdinText: "not json at all" });

    // Act / Assert
    await expect(hairMain(["node", "hair", "hook", "UserPromptSubmit"], seams)).resolves.toBeUndefined();
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
