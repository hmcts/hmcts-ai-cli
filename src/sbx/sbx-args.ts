import { REGISTRY_HOST, TOKEN_USER } from "../container/acr.js";
import { ALLOWED_SOURCES_KEY, DOCKER_VOLUME_KEY, DOCKER_VOLUME_SIZE, SBX_BIN } from "./kit.js";

/**
 * Both scopes, from one token: the host scope pulls the kit, and the `--all-sandboxes` scope is
 * what the Docker engine inside a sandbox uses — without it every hmctsprod pull there is refused.
 */
export const SECRET_SCOPES = [
  { flags: ["-f"], where: "the host" },
  { flags: ["--all-sandboxes"], where: "the sandboxes' own Docker engine" }
] as const;

/**
 * The create: `sbx run` with the kit and the workspaces, which sbx records in the sandbox's
 * spec. They mount at their host paths, so Claude Code's project slug matches the host's.
 */
export function buildCreateArgs(ctx: SbxContext): string[] {
  const argv = [SBX_BIN, "run", "--name", ctx.name];
  // sbx's default anyway; explicit so a stale cached kit is never reused.
  argv.push("--pull", "always");
  for (const [name, value] of Object.entries(ctx.env).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("--env", `${name}=${value}`);
  }
  argv.push(ctx.kit, ...ctx.workspaces);
  return [...argv, ...claudeArgs(ctx)];
}

/**
 * The reattach: with the sandbox already created, sbx reads the kit, the workspaces and
 * the environment back from its spec, so naming it is the whole argv.
 */
export function buildReattachArgs(ctx: SbxContext): string[] {
  return [SBX_BIN, "run", "--name", ctx.name, ...claudeArgs(ctx)];
}

export function buildVersionArgs(): string[] {
  return [SBX_BIN, "version", "--json"];
}

export function buildListArgs(): string[] {
  return [SBX_BIN, "ls"];
}

export function buildInspectArgs(name: string): string[] {
  return [SBX_BIN, "inspect", name, "--json"];
}

export function buildSettingsGetArgs(key: string): string[] {
  return [SBX_BIN, "settings", "get", key];
}

export function buildSettingsSetArgs(key: string, value: string): string[] {
  return [SBX_BIN, "settings", "set", key, value];
}

export function buildAllowedSourcesSetArgs(value: string): string[] {
  return buildSettingsSetArgs(ALLOWED_SOURCES_KEY, value);
}

export function buildDockerVolumeSetArgs(): string[] {
  return buildSettingsSetArgs(DOCKER_VOLUME_KEY, DOCKER_VOLUME_SIZE);
}

/** The token goes in on stdin, never in argv: `--password-stdin` is the only form used. */
export function buildSecretSetArgs(flags: readonly string[]): string[] {
  return [SBX_BIN, "secret", "set", ...flags, "--registry", REGISTRY_HOST, "--username", TOKEN_USER, "--password-stdin"];
}

export function buildKitDigestArgs(registry: string, repository: string): string[] {
  return ["az", "acr", "repository", "show", "--name", registry, "--image", repository, "--query", "digest", "-o", "tsv"];
}

export function buildKitIndexArgs(registry: string, repository: string): string[] {
  return ["az", "acr", "manifest", "show", "-r", registry, "-n", repository, "-o", "json"];
}

/** `--` first, so everything the engineer typed after `sbx-hai` reaches claude verbatim. */
function claudeArgs(ctx: SbxContext): string[] {
  return ctx.claudeArgs.length === 0 ? [] : ["--", ...ctx.claudeArgs];
}

export interface SbxContext {
  name: string;
  kit: string;
  /** The checkout first, then the shared history directory when it is being shared. */
  workspaces: string[];
  /** Only CFT_* forwarding. No credential and no route environment: see src/sbx/run.ts. */
  env: Record<string, string>;
  claudeArgs: string[];
}
