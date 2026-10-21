import { describe, expect, it } from "vitest";
import { createSeams } from "./seams.js";

describe("createSeams", () => {
  it("should wire up every seam from the real process", () => {
    // Act
    const seams = createSeams();

    // Assert
    expect(seams.platform).toBe(process.platform);
    expect(seams.cwd).toBe(process.cwd());
    expect(seams.execPath).toBe(process.execPath);
    expect(seams.scriptPath).toBe(process.argv[1]);
    expect(typeof seams.runner.run).toBe("function");
    expect(typeof seams.fs.readText).toBe("function");
    expect(typeof seams.net.fetch).toBe("function");
    expect(seams.clock.now()).toBeGreaterThan(0);
  });

  it("should write to stdout", () => {
    // Arrange
    const seams = createSeams();
    const written: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((text: string) => {
      written.push(text);
      return true;
    }) as typeof process.stdout.write;

    // Act
    seams.stdout("out\n");
    process.stdout.write = real;

    // Assert
    expect(written).toEqual(["out\n"]);
  });

  it("should log to stderr", () => {
    // Arrange
    const seams = createSeams();
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((text: string) => {
      written.push(text);
      return true;
    }) as typeof process.stderr.write;

    // Act
    seams.logger.say("said");
    process.stderr.write = real;

    // Assert
    expect(written).toEqual(["hai: said\n"]);
  });

  it("should take verbosity from the environment it captured", () => {
    // Arrange
    process.env.HAI_VERBOSE = "1";
    const seams = createSeams();
    delete process.env.HAI_VERBOSE;
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((text: string) => {
      written.push(text);
      return true;
    }) as typeof process.stderr.write;

    // Act
    seams.logger.verbose("detail");
    process.stderr.write = real;

    // Assert
    expect(written).toEqual(["hai: detail\n"]);
  });

  it("should exit the process", () => {
    // Arrange
    const seams = createSeams();
    const codes: number[] = [];
    const real = process.exit;
    process.exit = ((code: number) => {
      codes.push(code);
    }) as typeof process.exit;

    // Act
    seams.exit(3);
    process.exit = real;

    // Assert
    expect(codes).toEqual([3]);
  });
});
