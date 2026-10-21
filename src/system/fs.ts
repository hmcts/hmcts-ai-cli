import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";

export function createFs(): Fs {
  return {
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },

    async writeText(path, content, opts = {}) {
      await writeFile(path, content, { encoding: "utf8", mode: opts.mode });
      // writeFile only applies `mode` when it creates the file, so a pre-existing one
      // keeps whatever permissions it had. These files hold tokens, so set it either way.
      if (opts.mode !== undefined) {
        await chmod(path, opts.mode);
      }
    },

    async mkdirp(path, opts = {}) {
      await mkdir(path, { recursive: true, mode: opts.mode });
      if (opts.mode !== undefined) {
        await chmod(path, opts.mode);
      }
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

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface Fs {
  /** Null rather than a throw when the path is absent or unreadable: every caller treats both as "no signal". */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  mkdirp(path: string, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  listDir(path: string): Promise<DirEntry[]>;
}
