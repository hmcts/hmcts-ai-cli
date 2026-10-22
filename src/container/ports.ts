import type { Logger } from "../log/logger.js";
import type { Fs } from "../system/fs.js";
import type { Net } from "../system/net.js";

/** Where the kernel publishes the range it hands out as source ports. Linux only. */
export const LOCAL_PORT_RANGE_PATH = "/proc/sys/net/ipv4/ip_local_port_range";

/** Linux's own default, for a host that does not publish the range. */
export const EPHEMERAL_LOW_FALLBACK = 32768;

/** Loopback, which is what `describePortEntry` reports and so what a mapping should bind. */
const LOOPBACK_ADDRESS = "127.0.0.1";

/**
 * The whole rule, over whatever candidates it is given: a clashing port is left
 * unpublished, **never moved to another number**, because cftlib's IDAM simulator issues
 * and validates tokens under a fixed host and port, so XUI's sign-in redirect breaks as
 * soon as a port answers somewhere else. Each port is decided once — re-probing later
 * would only widen the window it cannot close anyway.
 */
export function selectPorts(probed: PortProbe[]): PortSelection {
  const publish: number[] = [];
  const skipped: number[] = [];
  for (const { port, free } of probed) {
    if (free) {
      publish.push(port);
    } else {
      skipped.push(port);
    }
  }
  return { publish, skipped };
}

/**
 * Docker's iptables chain bypasses the host firewall, so a published port answers anyone on
 * the network whatever ufw says, while the URL hai reports is `localhost`. The ports cftlib
 * publishes itself were already on 0.0.0.0; what is new is hai doing it for every port a
 * session turns out to listen on, so the default is loopback and HAI_PORTS_PUBLIC=1 opts out.
 */
export function publishArg(port: number, isPublic: boolean): string {
  return isPublic ? `${port}:${port}` : `${LOOPBACK_ADDRESS}:${port}:${port}`;
}

/** The low bound of the host's ephemeral range, from `ip_local_port_range`'s two numbers. */
export function parseEphemeralLow(text: string | null): number {
  const low = Number(text?.trim().split(/\s+/)[0]);
  return Number.isInteger(low) && low > 0 ? low : EPHEMERAL_LOW_FALLBACK;
}

export function ephemeralPortsMessage(ephemeral: number[], low: number): string {
  return `not publishing ${ephemeral.join(", ")}: at or above ${low}, where the host hands out ephemeral source ports, so holding the number would break whatever wanted it next.`;
}

/** Read once per watch; a platform without the file gets the fallback. */
export async function readEphemeralLow(deps: { fs: Fs }): Promise<number> {
  return parseEphemeralLow(await deps.fs.readText(LOCAL_PORT_RANGE_PATH));
}

export function skippedPortsMessage(skipped: number[]): string {
  return `not publishing ${skipped.join(", ")}: already in use on this host, so nothing in the session will answer on those numbers. A clashing port is skipped rather than moved to another number, because a moved port breaks the XUI to IDAM OAuth redirect.`;
}

/**
 * Probes a list of candidate ports on the host and reports what it will not publish, at
 * normal verbosity. Nothing here knows where the candidates came from.
 */
export async function chooseFreePorts(deps: { net: Net; logger: Logger }, candidates: number[]): Promise<number[]> {
  const probed: PortProbe[] = [];
  for (const port of candidates) {
    probed.push({ port, free: await deps.net.isPortFree(port) });
  }
  const { publish, skipped } = selectPorts(probed);
  if (skipped.length > 0) {
    deps.logger.say(skippedPortsMessage(skipped));
  }
  deps.logger.verbose(`publishing ${publish.length} of ${candidates.length} port(s)`);
  return publish;
}

export interface PortProbe {
  port: number;
  free: boolean;
}

export interface PortSelection {
  publish: number[];
  skipped: number[];
}
