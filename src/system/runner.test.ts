import { describe, expect, it } from "vitest";
import { exitCodeOf, exitSignal } from "../__fixtures__/fake-seams.js";
import { createRunner } from "./runner.js";

const NODE = process.execPath;

describe("createRunner", () => {
  describe("run", () => {
    it("should run a command and collect its output", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.stdout.write('out');process.stderr.write('err')"]);

      // Assert
      expect(result).toEqual({ code: 0, stdout: "out", stderr: "err" });
    });

    it("should report a non-zero exit", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.exit(3)"]);

      // Assert
      expect(result.code).toBe(3);
    });

    it("should pass stdin through", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.stdin.pipe(process.stdout)"], { stdin: "hello" });

      // Assert
      expect(result.stdout).toBe("hello");
    });

    it("should close stdin when there is nothing to send, so a reader does not hang", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.stdin.on('end', () => process.stdout.write('ended')); process.stdin.resume()"], {
        timeoutMs: 5000
      });

      // Assert
      expect(result.stdout).toBe("ended");
    });

    it("should run in the directory it was given", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.stdout.write(process.cwd())"], { cwd: "/tmp" });

      // Assert
      expect(result.stdout).toContain("tmp");
    });

    it("should hand over exactly the environment it was given", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.stdout.write(process.env.ONLY_THIS ?? 'missing')"], { env: { ONLY_THIS: "yes" } });

      // Assert
      expect(result.stdout).toBe("yes");
    });

    it("should report a command that cannot be started rather than reject", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run(["definitely-not-a-real-binary-9f8a7b"]);

      // Assert
      expect(result.code).toBe(127);
      expect(result.stderr).toContain("ENOENT");
    });

    it("should kill a command that overruns its timeout", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 });

      // Assert
      expect(result.code).toBe(124);
    });

    it("should never use a shell, so shell syntax is just an argument", async () => {
      // Arrange
      const runner = createRunner();

      // Act
      const result = await runner.run([NODE, "-e", "process.stdout.write(process.argv[1] ?? '')", "a; rm -rf /"]);

      // Assert
      expect(result.stdout).toBe("a; rm -rf /");
    });

    it("should refuse an empty argv", async () => {
      // Arrange
      const runner = createRunner();

      // Act / Assert
      await expect(runner.run([])).rejects.toThrow("cannot run an empty argv");
    });
  });

  describe("exec", () => {
    // The real exit never returns, so a runner built for a test is given one that throws.
    const execRunner = () =>
      createRunner({
        exit: (code: number): never => {
          throw exitSignal(code);
        }
      });

    it("should exit with the child's status", async () => {
      // Act
      const err = await execRunner()
        .exec([NODE, "-e", "process.exit(7)"])
        .catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(7);
    });

    it("should exit 128 when the child was killed by a signal", async () => {
      // Act
      const err = await execRunner()
        .exec([NODE, "-e", "process.kill(process.pid, 'SIGTERM')"])
        .catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(128);
    });

    it("should let the child own the terminal", async () => {
      // Act
      const err = await execRunner()
        .exec([NODE, "-e", "process.exit(0)"], { env: { PATH: process.env.PATH ?? "" }, cwd: "/tmp" })
        .catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
    });

    it("should reject when the command cannot be started at all", async () => {
      // Arrange
      const runner = createRunner();

      // Act / Assert
      await expect(runner.exec(["definitely-not-a-real-binary-9f8a7b"])).rejects.toThrow(/ENOENT/);
    });
  });
});
