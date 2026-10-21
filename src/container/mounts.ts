import type { Env } from "../system/env.js";
import { historyVolumeName } from "./session.js";

/**
 * The host's Docker socket, which the devcontainer shares and container mode must not:
 * the session runs its own engine, and handing it the host's would put every nested
 * container back on the host.
 */
export const DROPPED_MOUNT_SOURCES = ["/var/run/docker.sock"];

/** `--network=host` is what makes a nested daemon rewrite the host's docker0 and iptables. */
export const DROPPED_RUN_ARGS = ["--network=host", "--network", "host"];

export const DEFAULT_CONTAINER_USER = "hmcts";

/**
 * What a repo with no devcontainer.json of its own gets: the same credential and cache
 * surface cft-workspace's devcontainer.json asks for, since it is the same image.
 *
 * ~/.claude goes in wholesale, which is what makes a claude.ai licence work in the
 * container with no plumbing: the credential, the settings and the transcripts are all
 * the host's own.
 */
export const DEFAULT_HOME_BINDS: { path: string; readonly?: boolean }[] = [
  { path: ".claude" },
  { path: ".claude.json" },
  { path: ".zsh_history" },
  { path: ".bash_history" },
  { path: ".azure" },
  { path: ".kube" },
  { path: ".config/gh" },
  { path: ".config/twg" },
  { path: ".ssh", readonly: true }
];

/** Named with the devcontainer's `cft-` prefix, so the rename to `hai-` is the one rule below. */
export const DEFAULT_CACHE_VOLUMES: { source: string; path: string }[] = [
  { source: "cft-gradle", path: ".gradle" },
  { source: "cft-m2", path: ".m2" },
  { source: "cft-npm", path: ".npm" },
  { source: "cft-yarn", path: ".cache/yarn" },
  { source: "cft-codex", path: ".codex" }
];

export function defaultSpec(vars: SubstitutionVars): DevcontainerSpec {
  const home = vars.env.HOME ?? "";
  const containerHome = `/home/${DEFAULT_CONTAINER_USER}`;
  return {
    mounts: [
      ...DEFAULT_HOME_BINDS.map((bind) => ({
        kind: "bind" as const,
        source: `${home}/${bind.path}`,
        target: `${containerHome}/${bind.path}`,
        readonly: bind.readonly === true
      })),
      ...DEFAULT_CACHE_VOLUMES.map((volume) => ({
        kind: "volume" as const,
        source: volume.source,
        target: `${containerHome}/${volume.path}`,
        readonly: false
      }))
    ],
    runArgs: ["--privileged"],
    containerUser: DEFAULT_CONTAINER_USER,
    source: "hai's built-in list"
  };
}

/**
 * devcontainer.json is the authoritative list of what an engineer expects to find in the
 * container, so it is read rather than copied. Two things are deliberately dropped —
 * see DROPPED_MOUNT_SOURCES and DROPPED_RUN_ARGS.
 */
export function parseDevcontainer(json: string, vars: SubstitutionVars): DevcontainerSpec | null {
  let parsed: DevcontainerJson;
  try {
    parsed = JSON.parse(stripComments(json)) as DevcontainerJson;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const specs = Array.isArray(parsed.mounts) ? parsed.mounts.filter((spec): spec is string => typeof spec === "string") : [];
  const runArgs = Array.isArray(parsed.runArgs) ? parsed.runArgs.filter((arg): arg is string => typeof arg === "string") : [];
  return {
    mounts: parseMountSpecs(specs, vars),
    runArgs: runArgs.filter((arg) => !DROPPED_RUN_ARGS.includes(arg)),
    containerUser: typeof parsed.containerUser === "string" ? parsed.containerUser : DEFAULT_CONTAINER_USER,
    source: "the repo's .devcontainer/devcontainer.json"
  };
}

/**
 * The caches get `hai-*` volumes rather than the devcontainer's `cft-*` ones, so a hai
 * session and a devcontainer cannot fight over the same Gradle lock. HAI_SHARE_CACHES=1
 * opts back into sharing them.
 */
export function resolveMounts(input: {
  spec: DevcontainerSpec;
  shareCaches: boolean;
  ownHistory: boolean;
  sessionName: string;
  containerHome: string;
  extra?: string;
}): Mount[] {
  const mounts = input.spec.mounts.map((mount) => (input.shareCaches ? mount : renameCacheVolume(mount)));
  if (input.ownHistory) {
    // Nested over the ~/.claude bind, so the licence and settings still come from the
    // host while the transcripts stay in the session's own volume.
    mounts.push({ kind: "volume", source: historyVolumeName(input.sessionName), target: `${input.containerHome}/.claude/projects` });
  }
  return [...mounts, ...parseExtraMounts(input.extra)];
}

/** `HAI_MOUNTS=/host/path:/container/path[:ro],…` */
export function parseExtraMounts(spec: string | undefined): Mount[] {
  if (spec === undefined || spec === "") {
    return [];
  }
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const parts = entry.split(":");
      const [source, target, flag] = parts;
      if (parts.length < 2 || parts.length > 3 || source === undefined || source === "" || target === undefined || target === "") {
        throw new Error(`HAI_MOUNTS entry "${entry}" is not source:target or source:target:ro`);
      }
      if (flag !== undefined && flag !== "ro") {
        throw new Error(`HAI_MOUNTS entry "${entry}" has a third field that is not "ro"`);
      }
      return { kind: "bind" as const, source, target, readonly: flag === "ro" };
    });
}

export function renderMount(mount: Mount): string {
  const parts = [`type=${mount.kind}`, `source=${mount.source}`, `target=${mount.target}`];
  if (mount.readonly === true) {
    parts.push("readonly");
  }
  return parts.join(",");
}

const LOCAL_WORKSPACE_FOLDER = /\$\{localWorkspaceFolder\}/g;
const LOCAL_ENV = /\$\{localEnv:([^}]+)\}/g;

/** The devcontainer `localEnv` and `localWorkspaceFolder` variables, the only two forms these files use. */
export function substitute(text: string, vars: SubstitutionVars): string {
  return text.replace(LOCAL_WORKSPACE_FOLDER, vars.workspaceFolder).replace(LOCAL_ENV, (_match, name: string) => vars.env[name] ?? "");
}

function parseMountSpecs(specs: string[], vars: SubstitutionVars): Mount[] {
  const mounts: Mount[] = [];
  for (const spec of specs) {
    const fields = new Map<string, string>();
    let readonly = false;
    for (const field of substitute(spec, vars).split(",")) {
      const [key, value] = field.split("=", 2);
      if (value === undefined) {
        readonly = readonly || field.trim() === "readonly" || field.trim() === "ro";
      } else {
        fields.set(key!.trim(), value.trim());
      }
    }
    const source = fields.get("source");
    const target = fields.get("target");
    const kind = fields.get("type") === "volume" ? "volume" : "bind";
    if (source === undefined || target === undefined || DROPPED_MOUNT_SOURCES.includes(source)) {
      continue;
    }
    mounts.push({ kind, source, target, readonly: readonly || fields.get("readonly") === "true" });
  }
  return mounts;
}

function renameCacheVolume(mount: Mount): Mount {
  if (mount.kind !== "volume" || !mount.source.startsWith("cft-")) {
    return mount;
  }
  return { ...mount, source: `hai-${mount.source.slice("cft-".length)}` };
}

/** devcontainer.json is JSONC. Only line comments appear in the ones in these repos. */
function stripComments(json: string): string {
  return json.replace(/^\s*\/\/.*$/gm, "");
}

interface DevcontainerJson {
  mounts?: unknown;
  runArgs?: unknown;
  containerUser?: unknown;
}

export interface Mount {
  kind: "bind" | "volume";
  source: string;
  target: string;
  readonly?: boolean;
}

export interface DevcontainerSpec {
  mounts: Mount[];
  runArgs: string[];
  containerUser: string;
  source: string;
}

export interface SubstitutionVars {
  env: Env;
  workspaceFolder: string;
}
