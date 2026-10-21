import { type Mount, renderMount } from "./mounts.js";

export const DOCKER_BIN = "docker";
export const DEFAULT_IMAGE = "hmctsprod.azurecr.io/cft-workspace/devcontainer:latest";

/** Read-only, and invoked as `bash <script>` so the staged copies need no execute bit. */
export const RUNTIME_MOUNT_POINT = "/opt/hai";
export const SUPERVISOR = `${RUNTIME_MOUNT_POINT}/supervisor.sh`;
export const ENTRYPOINT = `${RUNTIME_MOUNT_POINT}/entrypoint.sh`;
export const RECEIVE_SECRET = `${RUNTIME_MOUNT_POINT}/receive-secret.sh`;
export const RECEIVE_DOCKER_CONFIG = `${RUNTIME_MOUNT_POINT}/receive-docker-config.sh`;

/** tmpfs, so the credentials delivered into it never reach a disk. */
export const SECRETS_DIR = "/run/hai-secrets";
export const NESTED_DOCKER_DIR = "/var/lib/docker";

/** The image's own user. dockerd needs root, so the container runs as root and the session execs as this. */
export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;

/** cftlib's IDAM simulator issues tokens under this name and validates them under it too. */
export const ADD_HOST = "idam-simulator:127.0.0.1";

/**
 * The whole `docker run` argv, as one pure function over gathered facts, so every
 * decision in it is snapshot-testable per platform, route and port profile — and so the
 * "no secret ever reaches the container config" guarantee is a test rather than a habit.
 *
 * Nothing from ctx.secretEnv is read here on purpose: secrets go in on a `docker exec`
 * stdin, because anything in --env or --env-file is readable afterwards with
 * `docker inspect` and is persisted in the container's config on disk.
 */
export function buildDockerArgs(ctx: ContainerContext): string[] {
  const argv = [
    DOCKER_BIN,
    "run",
    "-d",
    "--name",
    ctx.sessionName,
    // The nested daemon needs root; the interactive session execs back down to the image's user.
    "--user",
    "0:0",
    "--privileged",
    "--init",
    // Its own network namespace. A second dockerd sharing the host's rewrites the host's
    // docker0 and flushes the host daemon's iptables chains.
    "--network",
    ctx.network
  ];
  for (const server of ctx.dns) {
    argv.push("--dns", server);
  }
  argv.push(
    "--add-host",
    ADD_HOST,
    "--shm-size=2g",
    "--ulimit",
    "nofile=65536:65536",
    "--cgroupns=private",
    "--tmpfs",
    "/run:exec,mode=0755",
    "--tmpfs",
    `${ctx.secretsDir}:mode=0700,uid=${CONTAINER_UID},gid=${CONTAINER_GID}`,
    "--mount",
    renderMount({ kind: "volume", source: ctx.dockerVolume, target: NESTED_DOCKER_DIR }),
    // At its own host path, so Claude Code's project slug — and so the transcript history
    // and the lock that guards it — match a session run on the host.
    "--mount",
    renderMount({ kind: "bind", source: ctx.repoPath, target: ctx.repoPath })
  );
  for (const mount of ctx.mounts) {
    argv.push("--mount", renderMount(mount));
  }
  argv.push("--mount", renderMount({ kind: "bind", source: ctx.runtimeDir, target: RUNTIME_MOUNT_POINT, readonly: true }), "-w", ctx.workdir);
  for (const port of ctx.ports) {
    argv.push("-p", `${port}:${port}`);
  }
  for (const [name, value] of Object.entries(ctx.env).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("--env", `${name}=${value}`);
  }
  return [...argv, ctx.image, "bash", SUPERVISOR];
}

/** The interactive session: a second exec, as the image's user, into the already-running container. */
export function buildSessionExecArgs(ctx: ContainerContext, claudeArgv: string[]): string[] {
  const argv = [DOCKER_BIN, "exec", "-i"];
  if (ctx.tty) {
    argv.push("-t");
  }
  return [...argv, "--user", ctx.containerUser, "-w", ctx.workdir, ctx.sessionName, "bash", ENTRYPOINT, ...claudeArgv];
}

export function buildSecretExecArgs(ctx: ContainerContext, name: string): string[] {
  return [DOCKER_BIN, "exec", "-i", "--user", ctx.containerUser, ctx.sessionName, "bash", RECEIVE_SECRET, name];
}

export function buildDockerConfigExecArgs(ctx: ContainerContext): string[] {
  return [DOCKER_BIN, "exec", "-i", "--user", ctx.containerUser, ctx.sessionName, "bash", RECEIVE_DOCKER_CONFIG];
}

export interface ContainerContext {
  image: string;
  sessionName: string;
  network: string;
  platform: string;
  /** The git toplevel, bind-mounted at this same path inside. */
  repoPath: string;
  /** Where the session starts: the cwd, which is the repo path unless hai was run from a subdirectory. */
  workdir: string;
  containerUser: string;
  containerHome: string;
  dockerVolume: string;
  secretsDir: string;
  /** The host directory holding the staged runtime scripts. */
  runtimeDir: string;
  dns: string[];
  /** Only the ports found free on the host: one clash must not abort the whole `docker run`. */
  ports: number[];
  mounts: Mount[];
  tty: boolean;
  /** Everything safe to record in the container config. */
  env: Record<string, string>;
  /** Carried only so that the no-secrets test has something real to look for. Never read here. */
  secretEnv: Record<string, string>;
}
