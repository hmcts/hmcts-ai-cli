import { type Env, isEnabled, isSet } from "./env.js";
import type { Fs } from "./fs.js";

const SANDBOX_ENV_FILE = "/etc/cft-sandbox-env.sh";
const DOCKER_ENV_FILE = "/.dockerenv";
const PODMAN_ENV_FILE = "/run/.containerenv";
const CGROUP_FILE = "/proc/1/cgroup";
const CGROUP_MARKERS = ["docker", "containerd", "kubepods"];

const SIGNALS: ContainerSignal[] = [
  { key: "ownMarker", label: "HAI_IN_CONTAINER=1", decides: true },
  { key: "hasDockerEnv", label: `${DOCKER_ENV_FILE} exists`, decides: true },
  { key: "isSandbox", label: `IS_SANDBOX=1 or ${SANDBOX_ENV_FILE} exists`, decides: true },
  { key: "hasRemoteContainersEnv", label: "REMOTE_CONTAINERS, REMOTE_CONTAINERS_IPC or CODESPACES is set", decides: true },
  { key: "hasPodmanEnv", label: `${PODMAN_ENV_FILE} exists`, decides: true },
  { key: "hasContainerEnvVar", label: "the container env var is set", decides: true },
  // Corroborating only. Under cgroup v2 a containerised pid 1 usually reports a bare
  // "0::/", so this probe is silent far more often than it fires and cannot be trusted
  // to decide on its own.
  { key: "cgroupMentionsContainer", label: `${CGROUP_FILE} mentions ${CGROUP_MARKERS.join("/")}`, decides: false }
];

export function isInContainer(probe: ContainerProbe): boolean {
  if (probe.forced) {
    return true;
  }
  return SIGNALS.some((signal) => signal.decides && probe[signal.key]);
}

export function containerReasons(probe: ContainerProbe): string[] {
  if (probe.forced) {
    return ["HAI_FORCE_CONTAINER=1"];
  }
  return SIGNALS.filter((signal) => probe[signal.key]).map((signal) => (signal.decides ? signal.label : `${signal.label} (corroborating only)`));
}

export async function probeContainer(deps: { env: Env; fs: Fs }): Promise<ContainerProbe> {
  const { env, fs } = deps;
  const cgroup = (await fs.readText(CGROUP_FILE)) ?? "";
  return {
    forced: isEnabled(env, "HAI_FORCE_CONTAINER"),
    ownMarker: isEnabled(env, "HAI_IN_CONTAINER"),
    hasDockerEnv: await fs.exists(DOCKER_ENV_FILE),
    isSandbox: isEnabled(env, "IS_SANDBOX") || (await fs.exists(SANDBOX_ENV_FILE)),
    hasRemoteContainersEnv: isSet(env, "REMOTE_CONTAINERS") || isSet(env, "REMOTE_CONTAINERS_IPC") || isSet(env, "CODESPACES"),
    hasPodmanEnv: await fs.exists(PODMAN_ENV_FILE),
    hasContainerEnvVar: isSet(env, "container"),
    cgroupMentionsContainer: CGROUP_MARKERS.some((marker) => cgroup.includes(marker))
  };
}

export interface ContainerProbe {
  forced: boolean;
  ownMarker: boolean;
  hasDockerEnv: boolean;
  isSandbox: boolean;
  hasRemoteContainersEnv: boolean;
  hasPodmanEnv: boolean;
  hasContainerEnvVar: boolean;
  cgroupMentionsContainer: boolean;
}

interface ContainerSignal {
  key: Exclude<keyof ContainerProbe, "forced">;
  label: string;
  decides: boolean;
}
