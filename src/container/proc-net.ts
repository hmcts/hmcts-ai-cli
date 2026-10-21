/**
 * The listening sockets inside the session container, read from its own /proc/net/tcp and
 * /proc/net/tcp6. This is cft-workspace's `scripts/lib/agent-hub/ports.mjs`, which reads the
 * same two tables inside a virtual agent's pod, ported to TypeScript.
 *
 * It is what catches the interesting case: when cftlib runs `docker compose` on the nested
 * daemon, each inner container's published port becomes a docker-proxy listener in the
 * session container's own network namespace, so it shows up here like any other server.
 */

/** Below this are the privileged ports, which nothing in a CFT stack listens on. */
export const MIN_PORT = 1024;
export const APPEAR_READS = 2;
export const DISAPPEAR_READS = 3;

const LISTEN = "0A";
const LOCAL_ADDRESS = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/;
const IPV6_LOOPBACK = "00000000000000000000000001000000";
const V4_MAPPED_PREFIX = "FFFF0000";

/**
 * 127.0.0.11, Docker's embedded DNS, which is in every container on a user-defined network
 * and on a new ephemeral port each time. It is never a server the engineer started, so
 * reporting it as a loopback-only listener is noise and its "bind to 0.0.0.0" hint is wrong.
 */
const DOCKER_DNS = "0B00007F";

/** Every socket in a /proc/net/tcp or tcp6 table: its hex local address, port and hex state. */
export function parseProcNet(text: string): ProcNetSocket[] {
  const sockets: ProcNetSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = LOCAL_ADDRESS.exec(fields[1] ?? "");
    if (local === null || fields[3] === undefined) {
      continue;
    }
    sockets.push({ address: local[1]!.toUpperCase(), port: Number.parseInt(local[2]!, 16), state: fields[3].toUpperCase() });
  }
  return sockets;
}

/**
 * `loopback` for 127.0.0.0/8, ::1 and ::ffff:127.x; otherwise `reachable`, which is to say
 * something outside the container can connect to it. The kernel prints each 32-bit word of
 * an address in host byte order, so 127.0.0.1 is 0100007F.
 */
export function addressKind(hex: string): "loopback" | "reachable" {
  if (hex.length === 8) {
    return ipv4Loopback(hex) ? "loopback" : "reachable";
  }
  if (hex === IPV6_LOOPBACK) {
    return "loopback";
  }
  if (hex.startsWith("0".repeat(16)) && hex.slice(16, 24) === V4_MAPPED_PREFIX && ipv4Loopback(hex.slice(24))) {
    return "loopback";
  }
  return "reachable";
}

/** Ports listening from MIN_PORT up, split into the reachable ones and those on loopback alone. */
export function listeners(sockets: ProcNetSocket[]): Listeners {
  const open = new Set<number>();
  const local = new Set<number>();
  for (const socket of sockets) {
    if (socket.state !== LISTEN || socket.port < MIN_PORT || socket.address === DOCKER_DNS) {
      continue;
    }
    (addressKind(socket.address) === "loopback" ? local : open).add(socket.port);
  }
  // A port bound on both 127.0.0.1 and 0.0.0.0 is reachable, so it is not loopback-only.
  return { open: ascending(open), local: ascending(local).filter((port) => !open.has(port)) };
}

/**
 * A port joins the set once seen on `appear` reads in a row and leaves it once missing from
 * `disappear` in a row, so a Gradle task that rebinds between ticks is not seen twice and a
 * port is never acted on from a single read of a table that was being written.
 */
export function createDebounce({ appear = APPEAR_READS, disappear = DISAPPEAR_READS } = {}): (current: number[]) => number[] {
  const ports = new Map<number, Sighting>();
  return (current) => {
    const now = new Set(current);
    for (const port of now) {
      if (!ports.has(port)) {
        ports.set(port, { seen: 0, missing: 0, shown: false });
      }
    }
    for (const [port, sighting] of ports) {
      if (now.has(port)) {
        sighting.seen += 1;
        sighting.missing = 0;
        sighting.shown = sighting.shown || sighting.seen >= appear;
      } else {
        sighting.seen = 0;
        sighting.missing += 1;
        if (!sighting.shown || sighting.missing >= disappear) {
          ports.delete(port);
        }
      }
    }
    return [...ports]
      .filter(([, sighting]) => sighting.shown)
      .map(([port]) => port)
      .sort(byNumber);
  };
}

function ipv4Loopback(word: string): boolean {
  return word.slice(6) === "7F";
}

function ascending(ports: Set<number>): number[] {
  return [...ports].sort(byNumber);
}

function byNumber(a: number, b: number): number {
  return a - b;
}

interface Sighting {
  seen: number;
  missing: number;
  shown: boolean;
}

export interface ProcNetSocket {
  address: string;
  port: number;
  state: string;
}

export interface Listeners {
  open: number[];
  local: number[];
}
