import { resolve } from "node:path";
import type { Fs } from "../system/fs.js";
import { REGISTRATION_HOOK_OVERRIDE_WARNING } from "./hooks.js";
import type { Settings } from "./settings.js";

export const SETTINGS_FLAG = "--settings";

const INLINE_PREFIX = `${SETTINGS_FLAG}=`;

const END_OF_OPTIONS = "--";

export const API_KEY_HELPER_OVERRIDE_WARNING =
  "your --settings replaces the apiKeyHelper hai generated for the ai-gateway route, so the Entra token will stop being refreshed and the session will start failing authentication a few minutes in";

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

/**
 * The user's keys win: an explicit `--settings` is their override, and explicit beats
 * implicit. `hooks` is the exception, and has to be: a shallow spread would let a user
 * who registers any hook of their own silently discard hai's session-registry hooks, and
 * the only symptom would be `hair` finding nothing to restore weeks later. Per event the
 * two lists are concatenated, hai's first, so both run.
 */
export function mergeSettings(ours: Settings, theirs: Settings): { settings: Settings; warnings: string[] } {
  const settings = { ...ours, ...theirs };
  const hooks = mergeHooks(ours.hooks, theirs.hooks);
  if (hooks !== undefined) {
    settings.hooks = hooks;
  }
  const warnings: string[] = [];
  if (ours.apiKeyHelper !== undefined && settings.apiKeyHelper !== ours.apiKeyHelper) {
    warnings.push(API_KEY_HELPER_OVERRIDE_WARNING);
  }
  if (isHookMap(ours.hooks) && !keepsOurHooks(ours.hooks, hooks)) {
    warnings.push(REGISTRATION_HOOK_OVERRIDE_WARNING);
  }
  return { settings, warnings };
}

/** Undefined when neither side has any, so no empty `hooks` key reaches claude. */
function mergeHooks(ours: unknown, theirs: unknown): unknown {
  if (!isHookMap(ours) || !isHookMap(theirs)) {
    // One of them is a shape this cannot reason about — a list, a string, a schema that
    // changed under us. The user's wins, as every other key does, and the warning says so.
    return theirs ?? ours;
  }
  const merged: Record<string, unknown> = { ...ours, ...theirs };
  for (const [event, mine] of Object.entries(ours)) {
    const yours = theirs[event];
    if (Array.isArray(mine) && Array.isArray(yours)) {
      merged[event] = [...mine, ...yours];
    }
  }
  return merged;
}

/** Every command hai registered has to still be in the merged settings, or it was replaced. */
function keepsOurHooks(ours: Record<string, unknown>, merged: unknown): boolean {
  // Wrapped in an array so this is a string whatever `merged` turned out to be.
  const commands = JSON.stringify([merged]);
  return hookCommands(ours).every((command) => commands.includes(JSON.stringify(command)));
}

function hookCommands(hooks: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const groups of Object.values(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const entry of Array.isArray((group as { hooks?: unknown }).hooks) ? (group as { hooks: unknown[] }).hooks : []) {
        const command = (entry as { command?: unknown }).command;
        if (typeof command === "string") {
          out.push(command);
        }
      }
    }
  }
  return out;
}

function isHookMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
