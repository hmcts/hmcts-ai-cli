import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_KEY_HELPER_SCRIPT, HELPER_FILE } from "../auth/gateway.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, statePath } from "../system/state-dir.js";

export const RUNTIME_SCRIPTS = ["supervisor.sh", "entrypoint.sh", "receive-secret.sh", "receive-docker-config.sh"];

export function packagedRuntimeDir(): string {
  return fileURLToPath(new URL("../../runtime/", import.meta.url));
}

export function stagedRuntimeDir(env: Env): string {
  const override = env.HAI_ENTRYPOINT_DIR;
  return override !== undefined && override !== "" ? override : statePath(env, "runtime");
}

/** Which staged copies are out of date, by content hash. Pure, so the gate is testable. */
export function stagingDecision(input: { wanted: Record<string, string>; staged: Record<string, string | null> }): string[] {
  return Object.keys(input.wanted)
    .filter((name) => hash(input.wanted[name]!) !== hash(input.staged[name] ?? null))
    .sort();
}

/**
 * The scripts ship in the package and are copied into the state directory so there is a
 * host path to bind-mount at /opt/hai: node_modules is not somewhere to mount from, and a
 * global install may not even be readable by the container's user.
 */
export async function stageRuntime(deps: { fs: Fs; env: Env }): Promise<string> {
  const dir = stagedRuntimeDir(deps.env);
  const wanted: Record<string, string> = {};
  for (const name of RUNTIME_SCRIPTS) {
    const contents = await deps.fs.readText(join(packagedRuntimeDir(), name));
    if (contents === null) {
      throw new Error(`hai's ${name} is missing from the installed package, so container mode cannot start`);
    }
    wanted[name] = contents;
  }
  // Generated rather than shipped, so the one copy of the script lives in gateway.ts.
  wanted[HELPER_FILE] = API_KEY_HELPER_SCRIPT;

  const staged: Record<string, string | null> = {};
  for (const name of Object.keys(wanted)) {
    staged[name] = await deps.fs.readText(join(dir, name));
  }

  const stale = stagingDecision({ wanted, staged });
  if (stale.length > 0) {
    await deps.fs.mkdirp(dir, { mode: STATE_DIR_MODE });
    for (const name of stale) {
      await deps.fs.writeText(join(dir, name), wanted[name]!, { mode: STATE_FILE_MODE });
    }
  }
  return dir;
}

function hash(contents: string | null): string {
  return contents === null ? "" : createHash("sha256").update(contents).digest("hex");
}
