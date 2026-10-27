import { constants, createReadStream } from "node:fs";
import { access, appendFile, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export function createFs(): Fs {
  return {
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },

    readLines(path) {
      return streamLines(path);
    },

    async writeText(path, content, opts = {}) {
      await writeFile(path, content, { encoding: "utf8", mode: opts.mode });
      // writeFile applies `mode` only when it creates the file, and these files hold tokens.
      if (opts.mode !== undefined) {
        await chmod(path, opts.mode);
      }
    },

    async appendText(path, content, opts = {}) {
      await appendFile(path, content, { encoding: "utf8", mode: opts.mode });
    },

    async createExclusive(path, content, opts = {}) {
      try {
        await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: opts.mode });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw err;
      }
    },

    async mkdirp(path, opts = {}) {
      await mkdir(path, { recursive: true, mode: opts.mode });
      if (opts.mode !== undefined) {
        await chmod(path, opts.mode);
      }
    },

    async rename(from, to) {
      await rename(from, to);
    },

    async remove(path) {
      await rm(path, { force: true, recursive: true });
    },

    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async isWritable(path) {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },

    async listDir(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      } catch {
        return [];
      }
    }
  };
}

/**
 * A line at a time off a read stream, so a file too large to hold can still be scanned.
 * Errors stop the iteration rather than propagating: an absent file yields nothing.
 */
async function* streamLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
      yield line;
    }
  } catch {
    return;
  } finally {
    // A consumer that stops early would otherwise leave the fd open.
    stream.destroy();
  }
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface Fs {
  /** Null rather than a throw when the path is absent or unreadable: every caller treats both as "no signal". */
  readText(path: string): Promise<string | null>;
  /** One line at a time, for the files too big to hold; an absent or unreadable path yields no lines. */
  readLines(path: string): AsyncIterable<string>;
  writeText(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  appendText(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  /** `O_EXCL`: creates the file, or reports that someone else already had. */
  createExclusive(path: string, content: string, opts?: { mode?: number }): Promise<boolean>;
  mkdirp(path: string, opts?: { mode?: number }): Promise<void>;
  /** Atomic within a filesystem, so a config seeded by writing a temp file next to it is never half-written. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  listDir(path: string): Promise<DirEntry[]>;
}
