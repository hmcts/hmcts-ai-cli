import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFs, type Fs } from "./fs.js";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

// The seams exist so the rest of the tree can be tested with fakes rather than by mocking
// a node builtin. Biome's noRestrictedImports enforces this too; this test is the belt to
// its braces, because Biome has been seen to inspect zero files and still exit 1.
const RESTRICTIONS: Restriction[] = [
  { module: "node:child_process", allowedIn: [join(SRC, "system", "runner.ts")] },
  { module: "node:fs", allowedIn: [join(SRC, "system", "fs.ts")] },
  { module: "node:fs/promises", allowedIn: [join(SRC, "system", "fs.ts")] },
  { module: "node:net", allowedIn: [join(SRC, "system", "net.ts")] }
];

async function sourceFiles(fs: Fs, dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.listDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      found.push(...(await sourceFiles(fs, path)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("import restrictions", () => {
  it("should have found the source tree to check", async () => {
    // Act
    const files = await sourceFiles(createFs(), SRC);

    // Assert
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(RESTRICTIONS)("should import $module only in $allowedIn", async ({ module, allowedIn }) => {
    // Arrange
    const fs = createFs();
    const files = await sourceFiles(fs, SRC);

    // Act
    const importers: string[] = [];
    for (const file of files) {
      const contents = (await fs.readText(file)) ?? "";
      if (new RegExp(`from "${module}"`).test(contents)) {
        importers.push(file);
      }
    }

    // Assert
    expect(importers.filter((file) => !allowedIn.includes(file))).toEqual([]);
  });
});

interface Restriction {
  module: string;
  allowedIn: string[];
}
