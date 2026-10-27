import { isAbsolute, join } from "node:path";
import type { Logger } from "../log/logger.js";
import type { Fs } from "../system/fs.js";
import { MARKETPLACE_FILE } from "./workspace-root.js";

const PLUGIN_MANIFEST = join(".claude-plugin", "plugin.json");

export function parsePluginNames(list: string | undefined): string[] {
  if (list === undefined || list === "") {
    return [];
  }
  // run.sh strips every whitespace character from a name, not just the ends.
  return list
    .split(",")
    .map((name) => name.replace(/\s/g, ""))
    .filter((name) => name !== "");
}

/**
 * Resolves AGENT_HUB_PLUGINS names through the workspace marketplace. A name that is missing
 * or has no plugin manifest is skipped with a note: a stale hub entry must not stop a session.
 */
export async function resolvePluginDirs(deps: { fs: Fs; logger: Logger; root: string; names: string[] }): Promise<string[]> {
  if (deps.names.length === 0) {
    return [];
  }
  const marketplacePath = join(deps.root, MARKETPLACE_FILE);
  const sources = await readMarketplace(deps.fs, marketplacePath);
  if (sources === null) {
    deps.logger.say(`could not read ${marketplacePath}; AGENT_HUB_PLUGINS (${deps.names.join(",")}) is ignored`);
    return [];
  }

  const dirs: string[] = [];
  for (const name of deps.names) {
    const source = sources.get(name);
    if (source === undefined) {
      deps.logger.say(`plugin ${name} is not in ${marketplacePath}; skipping it`);
      continue;
    }
    const dir = isAbsolute(source) ? source : join(deps.root, source.replace(/^\.\//, ""));
    if (!(await deps.fs.exists(join(dir, PLUGIN_MANIFEST)))) {
      deps.logger.say(`plugin ${name} has no ${join(dir, PLUGIN_MANIFEST)}; skipping it`);
      continue;
    }
    dirs.push(dir);
  }
  return dirs;
}

async function readMarketplace(fs: Fs, path: string): Promise<Map<string, string> | null> {
  const contents = await fs.readText(path);
  if (contents === null) {
    return null;
  }
  let parsed: { plugins?: unknown };
  try {
    parsed = JSON.parse(contents) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.plugins)) {
    return null;
  }
  const sources = new Map<string, string>();
  for (const plugin of parsed.plugins as { name?: unknown; source?: unknown }[]) {
    if (typeof plugin?.name === "string" && typeof plugin.source === "string" && !sources.has(plugin.name)) {
      sources.set(plugin.name, plugin.source);
    }
  }
  return sources;
}
