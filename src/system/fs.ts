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
      // writeFile only applies `mode` when it creates the file, so a pre-existing one
      // keeps whatever permissions it had. These files hold tokens, so set it either way.
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
 * A line at a time off a read stream, so a file far larger than anything worth holding can
 * still be scanned. Claude Code's transcripts are the case: the largest on one engineer's
 * machine is 198 MB, and `readText` would turn that into a single string.
 *
 * Errors stop the iteration rather than propagating, which is `readText`'s "null rather
 * than a throw" in iterator form — an absent file and a directory both yield nothing.
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
    // A consumer that stops early — and every caller here may — leaves the fd open
    // otherwise.
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
  /**
   * One line at a time, for the files that are too big to hold: a Claude Code transcript
   * runs to hundreds of megabytes. Nothing is thrown — an absent or unreadable path yields
   * no lines, the same signal `readText`'s null gives.
   */
  readLines(path: string): AsyncIterable<string>;
  writeText(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  /**
   * The port watcher's log, which is a running record rather than a state file — and the
   * session registry, where an O_APPEND write of one short line is what lets ten sessions
   * record themselves without a lock.
   */
  appendText(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  /**
   * `O_EXCL`: creates the file or reports that someone else already had. The only atomic
   * "exactly one of us wins" primitive available without a shell to run `flock`, and what
   * the restore claim is built on — ten terminals starting at once must not resume the
   * same conversation, because `claude -r` on a live session forks a copy of it.
   */
  createExclusive(path: string, content: string, opts?: { mode?: number }): Promise<boolean>;
  mkdirp(path: string, opts?: { mode?: number }): Promise<void>;
  /** Atomic within a filesystem, so a config seeded by writing a temp file next to it is never half-written. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  listDir(path: string): Promise<DirEntry[]>;
}
