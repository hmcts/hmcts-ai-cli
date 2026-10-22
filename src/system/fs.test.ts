import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFs } from "./fs.js";

const fs = createFs();
const root = join(tmpdir(), `hai-fs-test-${process.pid}`);

describe("createFs", () => {
  it("should report a missing file as null rather than throw", async () => {
    // Act / Assert
    expect(await fs.readText(join(root, "nothing"))).toBeNull();
  });

  it("should report a directory read as null, because it is not text", async () => {
    // Arrange
    await fs.mkdirp(root);

    // Act / Assert
    expect(await fs.readText(root)).toBeNull();
  });

  it("should write and read a file back", async () => {
    // Arrange
    const path = join(root, "written.txt");
    await fs.mkdirp(root);

    // Act
    await fs.writeText(path, "contents");

    // Assert
    expect(await fs.readText(path)).toBe("contents");
  });

  it("should apply the mode even when the file already exists with another one", async () => {
    // Arrange
    const path = join(root, "modes.txt");
    await fs.mkdirp(root);
    await fs.writeText(path, "first", { mode: 0o644 });

    // Act
    await fs.writeText(path, "second", { mode: 0o600 });

    // Assert
    const listed = await fs.listDir(root);
    expect(listed.map((entry) => entry.name)).toContain("modes.txt");
    expect(await fs.readText(path)).toBe("second");
  });

  it("should append to a file, and create it on the first append", async () => {
    // Arrange
    const path = join(root, "appended.log");
    await fs.mkdirp(root);
    await fs.remove(path);

    // Act
    await fs.appendText(path, "first\n", { mode: 0o600 });
    await fs.appendText(path, "second\n");

    // Assert
    expect(await fs.readText(path)).toBe("first\nsecond\n");
  });

  it("should let exactly one caller create a file, which is what a restore claim is", async () => {
    // Arrange
    const path = join(root, "claim.json");
    await fs.mkdirp(root);
    await fs.remove(path);

    // Act
    const first = await fs.createExclusive(path, "mine", { mode: 0o600 });
    const second = await fs.createExclusive(path, "yours");

    // Assert
    expect([first, second]).toEqual([true, false]);
    expect(await fs.readText(path)).toBe("mine");
  });

  it("should report a failure that is not EEXIST rather than swallow it as a lost race", async () => {
    // Arrange
    const path = join(root, "no-such-dir", "claim.json");

    // Act / Assert
    await expect(fs.createExclusive(path, "mine")).rejects.toThrow();
  });

  it("should create nested directories with a mode", async () => {
    // Arrange
    const dir = join(root, "a", "b");

    // Act
    await fs.mkdirp(dir, { mode: 0o700 });

    // Assert
    expect(await fs.exists(dir)).toBe(true);
  });

  it("should report a missing path as absent", async () => {
    // Act / Assert
    expect(await fs.exists(join(root, "absent"))).toBe(false);
  });

  it("should report a writable directory as writable", async () => {
    // Arrange
    await fs.mkdirp(root);

    // Act / Assert
    expect(await fs.isWritable(root)).toBe(true);
  });

  it("should report a path that is not there as not writable", async () => {
    // Act / Assert
    expect(await fs.isWritable(join(root, "nowhere", "deeper"))).toBe(false);
  });

  it("should list files and directories apart", async () => {
    // Arrange
    await fs.mkdirp(join(root, "listed", "sub"));
    await fs.writeText(join(root, "listed", "file.txt"), "x");

    // Act
    const entries = await fs.listDir(join(root, "listed"));

    // Assert
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "sub", isDirectory: true },
        { name: "file.txt", isDirectory: false }
      ])
    );
  });

  it("should list an unreadable directory as empty rather than throw", async () => {
    // Act / Assert
    expect(await fs.listDir(join(root, "not-there"))).toEqual([]);
  });

  it("should rename a file over an existing one, so a seeded config is never half-written", async () => {
    // Arrange
    await fs.mkdirp(root);
    await fs.writeText(join(root, "target.json"), "old");
    await fs.writeText(join(root, "temp.json"), "new");

    // Act
    await fs.rename(join(root, "temp.json"), join(root, "target.json"));

    // Assert
    expect(await fs.readText(join(root, "target.json"))).toBe("new");
    expect(await fs.exists(join(root, "temp.json"))).toBe(false);
  });

  it("should report a rename of something that is not there", async () => {
    // Act / Assert
    await expect(fs.rename(join(root, "gone"), join(root, "elsewhere"))).rejects.toThrow();
  });

  it("should remove a file, and say nothing about one that was already gone", async () => {
    // Arrange
    await fs.mkdirp(root);
    await fs.writeText(join(root, "doomed"), "x");

    // Act
    await fs.remove(join(root, "doomed"));
    await fs.remove(join(root, "doomed"));

    // Assert
    expect(await fs.exists(join(root, "doomed"))).toBe(false);
  });
});
