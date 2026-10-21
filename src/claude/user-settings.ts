import { resolve } from "node:path";
import type { Fs } from "../system/fs.js";
import type { Settings } from "./settings.js";

export const SETTINGS_FLAG = "--settings";

const INLINE_PREFIX = `${SETTINGS_FLAG}=`;

const END_OF_OPTIONS = "--";

export const API_KEY_HELPER_OVERRIDE_WARNING =
  "your --settings replaces the apiKeyHelper hai generated for the gateway route, so the Entra token will stop being refreshed and the session will start failing authentication a few minutes in";

/**
 * claude's `--settings` is last-wins, not merged: a second one discards the first
 * entirely. hai passes its own, so a user-supplied `--settings` has to come out of the
 * forwarded argv and be merged in, or whichever of the two loses is silently dropped.
 *
 * A bare `--` ends the options commander parses, so everything after it is prompt text
 * rather than flags: `hai -- --settings x` asks claude to read that literally.
 */
export function extractUserSettings(argv: string[]): { argv: string[]; value?: string } {
  const kept: string[] = [];
  let value: string | undefined;
  let awaitingValue = false;
  for (const [index, arg] of argv.entries()) {
    if (awaitingValue) {
      value = arg;
      awaitingValue = false;
    } else if (arg === END_OF_OPTIONS) {
      kept.push(...argv.slice(index));
      break;
    } else if (arg === SETTINGS_FLAG) {
      awaitingValue = true;
    } else if (arg.startsWith(INLINE_PREFIX)) {
      value = arg.slice(INLINE_PREFIX.length);
    } else {
      kept.push(arg);
    }
  }
  if (awaitingValue) {
    throw new Error(`${SETTINGS_FLAG} was given with no value`);
  }
  return { argv: kept, value };
}

/** The user's keys win: an explicit `--settings` is their override, and explicit beats implicit. */
export function mergeSettings(ours: Settings, theirs: Settings): { settings: Settings; warnings: string[] } {
  const settings = { ...ours, ...theirs };
  const replacesHelper = ours.apiKeyHelper !== undefined && settings.apiKeyHelper !== ours.apiKeyHelper;
  return { settings, warnings: replacesHelper ? [API_KEY_HELPER_OVERRIDE_WARNING] : [] };
}

/** Resolved as claude resolves it: a value starting with `{` is inline JSON, anything else is a path. */
export async function readUserSettings(deps: { fs: Fs; cwd: string }, value: string): Promise<Settings> {
  const json = value.trimStart().startsWith("{") ? value : await readSettingsFile(deps, value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${SETTINGS_FLAG} ${value} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_FLAG} ${value} is not a JSON object`);
  }
  return parsed as Settings;
}

async function readSettingsFile(deps: { fs: Fs; cwd: string }, value: string): Promise<string> {
  const path = resolve(deps.cwd, value);
  const contents = await deps.fs.readText(path);
  if (contents === null) {
    throw new Error(`${SETTINGS_FLAG} ${value} cannot be read (looked for ${path})`);
  }
  return contents;
}
