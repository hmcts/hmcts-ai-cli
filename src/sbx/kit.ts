import { REGISTRY_HOST } from "../container/acr.js";

export const SBX_BIN = "sbx";

/** The published cft-workspace kit. */
export const KIT_IMAGE = `${REGISTRY_HOST}/cft-workspace/sbx:latest`;
/** sbx only pulls kits from an allow-listed source, and defaults to Docker Hub alone. */
export const KIT_SOURCE = `${REGISTRY_HOST}/cft-workspace/`;
export const DEFAULT_ALLOWED_SOURCES = ["docker.io/"];

/** The ACR coordinates of the kit, for the staleness check. */
export const KIT_REGISTRY = REGISTRY_HOST.split(".")[0]!;
export const KIT_REPOSITORY = KIT_IMAGE.slice(`${REGISTRY_HOST}/`.length);

/** sbx's own 10g default is overrun by the CFT images, and /var/lib/docker then fills. */
export const DOCKER_VOLUME_KEY = "sandbox.disk.dockerVolume";
export const DOCKER_VOLUME_SIZE = "40g";
export const ALLOWED_SOURCES_KEY = "kit.allowedSources";

const SIZE = /^([0-9]+)([gmk]?)$/;
const VERSION = /^v[0-9]/;
const MIB_PER_GIB = 1024;
const BYTES_PER_MIB = 1048576;

/**
 * Once the sbx package is upgraded under a running sandboxd, sbx holds every command until
 * the daemon is restarted onto the installed version. It says so on a stderr prompt and
 * then reads stdin, so a piped or captured call throws the prompt away and waits for an
 * answer that never comes: the call hangs for good, having printed nothing. `sbx version`
 * is the one command that answers without the gate, which is why it is the probe.
 */
export function parseSbxVersion(stdout: string): SbxVersion {
  try {
    const parsed = JSON.parse(stdout) as { client?: { version?: unknown }; server?: { version?: unknown; state?: unknown } };
    return {
      client: asString(parsed.client?.version),
      server: asString(parsed.server?.version),
      state: asString(parsed.server?.state)
    };
  } catch {
    return { client: null, server: null, state: null };
  }
}

/**
 * The restart stops every running sandbox, other sessions' included, so it is reported
 * rather than done. A probe that cannot tell says nothing: the usual case is no mismatch,
 * and wrongly refusing to start would cost more than the hang this is here to prevent.
 */
export function daemonMismatch(version: SbxVersion): string | null {
  const { client, server, state } = version;
  if (client === null || server === null || !VERSION.test(client) || !VERSION.test(server)) {
    return null;
  }
  if (state !== "running" || client === server) {
    return null;
  }
  return (
    `the sbx CLI is ${client} but the sandboxd it talks to is still ${server}, so sbx is holding every command behind a prompt ` +
    "nothing can answer. Restart it yourself — it stops every running sandbox, other sessions' included — then re-run: sbx daemon restart"
  );
}

/** sbx refuses a kit from a source that is not on the list, so the create needs this first. */
export function allowedSourcesDecision(current: string | null): { needed: boolean; value: string } {
  const sources = parseStringArray(current) ?? DEFAULT_ALLOWED_SOURCES;
  if (sources.includes(KIT_SOURCE)) {
    return { needed: false, value: JSON.stringify(sources) };
  }
  return { needed: true, value: JSON.stringify([...new Set([...sources, KIT_SOURCE])]) };
}

/** Sizes as sbx states them: a number with an optional g/m/k suffix, or bytes without one. */
export function sizeMib(value: string | null): number {
  const match = SIZE.exec((value ?? "").trim().toLowerCase());
  if (match === null) {
    return 0;
  }
  const n = Number(match[1]);
  switch (match[2]) {
    case "g":
      return n * MIB_PER_GIB;
    case "m":
      return n;
    case "k":
      return Math.floor(n / MIB_PER_GIB);
    default:
      return Math.floor(n / BYTES_PER_MIB);
  }
}

/**
 * Host-wide, and read only as a sandbox is created, so this is the one moment it can be
 * put right. **Only ever raised**: a bigger size someone chose for their own sandboxes
 * stays. Anything unparseable reads as 0 and is therefore raised.
 */
export function volumeSizeDecision(current: string | null): { needed: boolean; reason: string } {
  if (sizeMib(current) >= sizeMib(DOCKER_VOLUME_SIZE)) {
    return { needed: false, reason: `new sandboxes' /var/lib/docker volume is already ${current}` };
  }
  return { needed: true, reason: `raising new sandboxes' /var/lib/docker volume to ${DOCKER_VOLUME_SIZE} (was ${current ?? "unset"})` };
}

/** `sbx ls` prints a header row and then one sandbox per line, name first. */
export function parseSandboxNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0]!)
    .filter((name) => name !== "");
}

/** `sbx inspect --json` is undocumented, so anything unexpected in it reads as null. */
export function parseKitRecord(stdout: string): KitRecord | null {
  try {
    const parsed = JSON.parse(stdout) as { kits?: unknown; image_digest?: unknown };
    const kits = Array.isArray(parsed.kits) ? parsed.kits : [];
    return { createdFrom: asString(kits[0]), digest: asString(parsed.image_digest) };
  } catch {
    return null;
  }
}

/** Whether the recorded kit can be compared with the published tag at all. */
export function kitComparable(record: KitRecord | null): { yes: boolean; reason: string } {
  if (record === null) {
    return { yes: false, reason: "sbx inspect could not be read, so the kit is treated as current" };
  }
  if (record.createdFrom?.startsWith("/")) {
    return { yes: false, reason: `the sandbox was built from the local kit at ${record.createdFrom}` };
  }
  if (record.createdFrom !== KIT_IMAGE) {
    return { yes: false, reason: `the sandbox was created from ${record.createdFrom ?? "an unrecorded kit"}, not ${KIT_IMAGE}` };
  }
  if (record.digest === null || record.digest === "") {
    return { yes: false, reason: "the sandbox records no image digest" };
  }
  return { yes: true, reason: `the sandbox was created from ${record.digest}` };
}

/**
 * `latest` is the tag's digest and `indexDigests` the children of the multi-arch index it
 * points at. A sandbox records the digest of the one arch that was pulled, so a difference
 * from the tag is not staleness by itself — that is a real false positive. Nothing here may
 * stop a launch, so every path that cannot tell reports not stale.
 */
export function kitStaleness(input: { recorded: string; latest: string | null; indexDigests: string[] | null }): { stale: boolean; reason: string } {
  if (input.latest === null || input.latest === "") {
    return { stale: false, reason: `could not read the published digest of ${KIT_IMAGE}` };
  }
  if (input.latest === input.recorded) {
    return { stale: false, reason: `the sandbox is on the published ${KIT_IMAGE}` };
  }
  if (input.indexDigests === null) {
    return { stale: false, reason: `could not read the manifest index of ${KIT_IMAGE}, so the digest difference says nothing` };
  }
  if (input.indexDigests.includes(input.recorded)) {
    return { stale: false, reason: "the recorded digest is one architecture of the published index" };
  }
  return { stale: true, reason: `${KIT_IMAGE} is now ${input.latest}, and the sandbox's ${input.recorded} is not part of it` };
}

export function staleKitMessage(name: string): string {
  return `a newer kit is published than sandbox ${name} was created from. Remove it with \`sbx rm -f ${name}\` and re-run to pick the new one up — its az login, kube contexts and build caches go with it.`;
}

export function parseIndexDigests(stdout: string): string[] | null {
  try {
    const parsed = JSON.parse(stdout) as { manifests?: unknown };
    if (!Array.isArray(parsed.manifests)) {
      return null;
    }
    return parsed.manifests.map((entry) => asString((entry as { digest?: unknown })?.digest)).filter((digest): digest is string => digest !== null);
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export interface SbxVersion {
  client: string | null;
  server: string | null;
  state: string | null;
}

export interface KitRecord {
  createdFrom: string | null;
  digest: string | null;
}
