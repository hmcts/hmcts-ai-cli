import type { Logger } from "../log/logger.js";
import type { Net } from "../system/net.js";

/** The ports a CFT stack actually listens on: cftlib, XUI, CCD, IDAM, Postgres, Redis, Elasticsearch. */
export const CFT_PORTS = ["3000", "3001", "3100", "3206", "3209", "3453", "3460", "4096", "4451-4456", "5062", "5555", "6432", "8087", "8489", "9200"];

/** A frontend and its API, for a service-team repo that is not running the whole stack. */
export const MINIMAL_PORTS = ["3000", "3001"];

export const PORT_PROFILES: Record<string, string[]> = { cft: CFT_PORTS, minimal: MINIMAL_PORTS, none: [] };

const PORT_SPEC = /^\d{1,5}(-\d{1,5})?$/;
const MAX_PORT = 65535;

const ALLOCATED = /port is already allocated/i;
const BIND_FAILURE = /Bind for \S*?:(\d{1,5}) failed/i;

/**
 * The create-time profile asked for, as written. Which of these are actually published is
 * `choosePorts`. Nothing by default: a hand-maintained list of 20 is wrong for every repo
 * that is not CCD or PCS, and clashes with whatever else the engineer is running, so the
 * port watcher publishes what the session turns out to listen on instead. `HAI_PORTS` is
 * for the ports that have to answer from the session's first instant.
 */
export function resolvePorts(spec: string | undefined): string[] {
  if (spec === undefined || spec === "") {
    return [];
  }
  const profile = PORT_PROFILES[spec];
  if (profile !== undefined) {
    return profile;
  }
  const entries = spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const bad = entries.filter((entry) => !PORT_SPEC.test(entry) || !inRange(entry));
  if (entries.length === 0 || bad.length > 0) {
    throw new Error(`HAI_PORTS=${spec} is not cft, minimal, none or a comma-separated list of ports and port ranges (${bad.join(", ")})`);
  }
  return entries;
}

/** Ranges become their members, so each port is probed and published on its own. */
export function expandPorts(specs: string[]): number[] {
  const ports = new Set<number>();
  for (const spec of specs) {
    const [start, end] = spec.split("-");
    const from = Number(start);
    const to = end === undefined ? from : Number(end);
    for (let port = from; port <= to; port += 1) {
      ports.add(port);
    }
  }
  return [...ports];
}

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

export function skippedPortsMessage(skipped: number[]): string {
  return `not publishing ${skipped.join(", ")}: already in use on this host, so nothing in the session will answer on those numbers. A clashing port is skipped rather than moved to another number, because a moved port breaks the XUI to IDAM OAuth redirect.`;
}

/**
 * The probe cannot close the race with whatever else is starting on this host, so when the
 * daemon refuses the bind anyway the message says which port it was and that hai had just
 * found it free — the raw daemon error reads like a hai bug instead.
 */
export function portClashMessage(input: { stderr: string; published: number[] }): string | null {
  if (!ALLOCATED.test(input.stderr)) {
    return null;
  }
  const named = BIND_FAILURE.exec(input.stderr)?.[1];
  const which = named === undefined ? `one of the ports hai published (${input.published.join(", ")})` : `port ${named}`;
  return `${which} was free moments earlier, when hai checked, and something else took it before the container could bind it. Try again, or set HAI_PORTS=none to publish nothing.`;
}

/**
 * Probes a list of candidate ports on the host and reports what it will not publish, at
 * normal verbosity. Nothing here knows where the candidates came from: a create-time
 * profile and a port a listener in the session has just claimed get the same decision.
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

/** The create-time list: the profile `HAI_PORTS` asks for, probed once. */
export async function choosePorts(deps: { net: Net; logger: Logger }, spec: string | undefined): Promise<number[]> {
  return await chooseFreePorts(deps, expandPorts(resolvePorts(spec)));
}

function inRange(entry: string): boolean {
  const [start, end] = entry.split("-");
  const from = Number(start);
  const to = end === undefined ? from : Number(end);
  return from >= 1 && to <= MAX_PORT && from <= to;
}

export interface PortProbe {
  port: number;
  free: boolean;
}

export interface PortSelection {
  publish: number[];
  skipped: number[];
}
