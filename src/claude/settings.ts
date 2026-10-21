import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDir, statePath } from "../system/state-dir.js";

export const SETTINGS_FILE = "settings.json";

export function buildSettings(input: { inWorkspace: boolean; apiKeyHelperPath?: string }): Record<string, string> {
  const settings: Record<string, string> = {};
  if (input.inWorkspace) {
    // Claude Code ignores crossSessionInbound in project settings, so it has to come in
    // through --settings.
    settings.crossSessionInbound = "accept";
  }
  if (input.apiKeyHelperPath !== undefined) {
    settings.apiKeyHelper = input.apiKeyHelperPath;
  }
  return settings;
}

/**
 * `--settings` takes either JSON or a path. A path is only worth the write when the
 * settings carry the apiKeyHelper, which has to live next to the helper script in the
 * 0700 state dir anyway.
 */
export async function materialiseSettings(deps: { fs: Fs; env: Env }, settings: Settings, asFile: boolean): Promise<string | undefined> {
  if (Object.keys(settings).length === 0) {
    return undefined;
  }
  const json = JSON.stringify(settings);
  if (!asFile) {
    return json;
  }
  const path = statePath(deps.env, SETTINGS_FILE);
  await deps.fs.mkdirp(stateDir(deps.env), { mode: STATE_DIR_MODE });
  await deps.fs.writeText(path, `${json}\n`, { mode: STATE_FILE_MODE });
  return path;
}

/** A user-supplied `--settings` can carry any shape claude accepts, not just hai's strings. */
export type Settings = Record<string, unknown>;
