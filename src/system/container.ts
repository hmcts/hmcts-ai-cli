import { type Env, isEnabled, isSet } from "./env.js";
import type { Fs } from "./fs.js";

const SANDBOX_ENV_FILE = "/etc/cft-sandbox-env.sh";
const DOCKER_ENV_FILE = "/.dockerenv";

/** Every signal decides on its own; the list exists so the reasons and the decision cannot drift apart. */
const SIGNALS: ContainerSignal[] = [
  { key: "ownMarker", label: "HAI_IN_CONTAINER=1" },
  { key: "hasDockerEnv", label: `${DOCKER_ENV_FILE} exists` },
  { key: "isSandbox", label: `IS_SANDBOX=1 or ${SANDBOX_ENV_FILE} exists` },
  { key: "hasRemoteContainersEnv", label: "REMOTE_CONTAINERS, REMOTE_CONTAINERS_IPC or CODESPACES is set" }
];

export function isInContainer(probe: ContainerProbe): boolean {
  // HAI_FORCE_HOST wins over everything, including HAI_FORCE_CONTAINER: it is how
  // container mode is exercised from inside a devcontainer, which otherwise detects
  // itself and takes the already-containerised path.
  if (probe.forcedHost) {
    return false;
  }
  if (probe.forced) {
    return true;
  }
  return SIGNALS.some((signal) => probe[signal.key]);
}

export function containerReasons(probe: ContainerProbe): string[] {
  if (probe.forcedHost) {
    return ["HAI_FORCE_HOST=1"];
  }
  if (probe.forced) {
    return ["HAI_FORCE_CONTAINER=1"];
  }
  return SIGNALS.filter((signal) => probe[signal.key]).map((signal) => signal.label);
}

export async function probeContainer(deps: { env: Env; fs: Fs }): Promise<ContainerProbe> {
  const { env, fs } = deps;
  return {
    forcedHost: isEnabled(env, "HAI_FORCE_HOST"),
    forced: isEnabled(env, "HAI_FORCE_CONTAINER"),
    ownMarker: isEnabled(env, "HAI_IN_CONTAINER"),
    hasDockerEnv: await fs.exists(DOCKER_ENV_FILE),
    isSandbox: isEnabled(env, "IS_SANDBOX") || (await fs.exists(SANDBOX_ENV_FILE)),
    hasRemoteContainersEnv: isSet(env, "REMOTE_CONTAINERS") || isSet(env, "REMOTE_CONTAINERS_IPC") || isSet(env, "CODESPACES")
  };
}

export interface ContainerProbe {
  forcedHost: boolean;
  forced: boolean;
  ownMarker: boolean;
  hasDockerEnv: boolean;
  isSandbox: boolean;
  hasRemoteContainersEnv: boolean;
}

interface ContainerSignal {
  key: Exclude<keyof ContainerProbe, "forced" | "forcedHost">;
  label: string;
}
