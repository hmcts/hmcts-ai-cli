import { dirname, join } from "node:path";
import { createLogger, type Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import { type Env, isEnabled } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Net } from "../system/net.js";
import type { Runner } from "../system/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, statePath } from "../system/state-dir.js";
import { DOCKER_BIN } from "./docker-args.js";
import { chooseFreePorts, ephemeralPortsMessage, publishArg, readEphemeralLow } from "./ports.js";
import { createDebounce, listeners, parseProcNet } from "./proc-net.js";

/**
 * One container per port, forwarding to the session over the user-defined network. Docker
 * cannot add a mapping to a running container — `docker update` has no `--publish`, and
 * mappings are create-time only — so a port a server in the session starts listening on can
 * only be published by something that is itself created with a `-p`.
 */
export const SOCAT_IMAGE = "alpine/socat";

/** What the sweep matches on. The session container deliberately does not carry it. */
export const SESSION_LABEL = "hai.session";

export const POLL_MS = 2000;
export const PULL_TIMEOUT_MS = 120_000;

/** So the agent in the session can discover the URLs its own servers are reachable at. */
export const IN_SESSION_PORTS_FILE = "/tmp/hai-ports.json";

const PROC_NET_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

export function sidecarName(session: string, port: number): string {
  return `${session}-port-${port}`;
}

/**
 * A host-side TCP proxy to the session's own address was the alternative and is dead on
 * Docker Desktop, where the bridge lives inside the VM and 172.17.x.x is unreachable from
 * the Mac. A sidecar is a container with a real `-p`, so Docker Desktop forwards it like
 * any other.
 */
export function buildSidecarArgs(input: { sessionName: string; network: string; port: number; publicPorts: boolean }): string[] {
  return [
    DOCKER_BIN,
    "run",
    "-d",
    "--rm",
    "--name",
    sidecarName(input.sessionName, input.port),
    "--network",
    input.network,
    "-p",
    publishArg(input.port, input.publicPorts),
    "--label",
    `${SESSION_LABEL}=${input.sessionName}`,
    SOCAT_IMAGE,
    `TCP-LISTEN:${input.port},fork,reuseaddr`,
    `TCP:${input.sessionName}:${input.port}`
  ];
}

export function buildReadTablesArgs(ctx: SessionRef): string[] {
  return [DOCKER_BIN, "exec", "--user", ctx.containerUser, ctx.sessionName, "cat", ...PROC_NET_TABLES];
}

export function buildWriteStateArgs(ctx: SessionRef): string[] {
  return [DOCKER_BIN, "exec", "-i", "--user", ctx.containerUser, ctx.sessionName, "sh", "-c", `cat > ${IN_SESSION_PORTS_FILE}`];
}

export function buildSweepListArgs(sessionName: string): string[] {
  return [DOCKER_BIN, "ps", "-aq", "--filter", `label=${SESSION_LABEL}=${sessionName}`];
}

export function buildSweepRemoveArgs(ids: string[]): string[] {
  return [DOCKER_BIN, "rm", "-f", ...ids];
}

export function sweepIds(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function portsLogPath(env: Env, sessionName: string): string {
  return join(statePath(env, "ports"), `${sessionName}.log`);
}

export function portsStatePath(env: Env, sessionName: string): string {
  return join(statePath(env, "ports"), `${sessionName}.ports.json`);
}

/**
 * Which of the ports now listening still need a decision. A port is decided once and never
 * revisited: a host number another process holds is reported once rather than every tick,
 * and a port already published at create time was decided by `choosePorts`. One in the
 * host's ephemeral range is nothing to hold, which is what bounds the sidecars.
 */
export function pendingPorts(input: { open: number[]; local: number[]; decided: number[]; noted: number[]; ephemeralLow: number }): PendingPorts {
  const decided = new Set(input.decided);
  const noted = new Set(input.noted);
  const undecided = (port: number) => !decided.has(port);
  const wanted = (port: number) => undecided(port) && port < input.ephemeralLow;
  return {
    publish: input.open.filter(wanted),
    loopback: input.local.filter((port) => wanted(port) && !noted.has(port)),
    ephemeral: [...input.open, ...input.local].filter((port) => undecided(port) && port >= input.ephemeralLow)
  };
}

export function describePortEntry(entry: PortEntry): string {
  switch (entry.state) {
    case "published":
      return `published ${entry.port} -> ${entry.url}`;
    case "skipped-host-port-in-use":
      return `skipped ${entry.port}: the host already has something on that number, so nothing in the session will answer on it. A clashing port is skipped rather than moved, because a moved port breaks the XUI to IDAM OAuth redirect.`;
    case "loopback-only":
      return `skipped ${entry.port}: it listens on 127.0.0.1 inside the session, which nothing outside can reach. Bind it to 0.0.0.0 to have it published.`;
    default:
      // The sidecar's `docker run` hitting the runner's timeout says nothing at all.
      return `could not publish ${entry.port}: ${firstLine(entry.detail ?? "")}`;
  }
}

export function socatMissingMessage(stderr: string): string {
  return (
    `${SOCAT_IMAGE} is not available (${firstLine(stderr)}), so a port a server in the session starts will not be published on the host. ` +
    `Everything else in the session works; pull it once with docker pull ${SOCAT_IMAGE}, or set HAI_PORTS to publish the ports you need at create time.`
  );
}

/** Pulled once per host. A session must start without it, just without dynamic publishing. */
export async function ensureSocatImage(deps: { runner: Runner; logger: Logger }): Promise<boolean> {
  if ((await deps.runner.run([DOCKER_BIN, "image", "inspect", SOCAT_IMAGE])).code === 0) {
    return true;
  }
  const pulled = await deps.runner.run([DOCKER_BIN, "pull", SOCAT_IMAGE], { timeoutMs: PULL_TIMEOUT_MS });
  if (pulled.code === 0) {
    deps.logger.verbose(`pulled ${SOCAT_IMAGE}, which publishes the ports the session starts listening on`);
    return true;
  }
  deps.logger.say(socatMissingMessage(pulled.stderr));
  return false;
}

/**
 * Every sidecar this session's name is on, removed. A sidecar outliving its session would
 * hold a host port whose server died with the session, so this runs both before a container
 * is created and once its session has ended.
 */
export async function sweepSidecars(deps: { runner: Runner; logger: Logger }, sessionName: string): Promise<number> {
  const listed = await deps.runner.run(buildSweepListArgs(sessionName));
  const ids = listed.code === 0 ? sweepIds(listed.stdout) : [];
  if (ids.length === 0) {
    return 0;
  }
  const removed = await deps.runner.run(buildSweepRemoveArgs(ids));
  if (removed.code !== 0) {
    deps.logger.say(`could not remove ${ids.length} published-port container(s) for ${sessionName}: ${removed.stderr.trim()}`);
    return 0;
  }
  deps.logger.verbose(`removed ${ids.length} published-port container(s) for ${sessionName}`);
  return ids.length;
}

/**
 * The log and the two copies of the state: one in the state directory and one inside the
 * session. A write that fails is logged and dropped — the session is worth more than the
 * record of it, and the next note writes the whole state again.
 */
export function createPortRecord(deps: { fs: Fs; runner: Runner; clock: Clock; env: Env; logger: Logger }, ctx: SessionRef): PortRecord {
  const path = portsStatePath(deps.env, ctx.sessionName);
  const entries = new Map<number, PortEntry>();

  async function write(): Promise<void> {
    const body = `${JSON.stringify(
      { session: ctx.sessionName, updated: stamp(deps.clock), ports: [...entries.values()].sort((a, b) => a.port - b.port) },
      null,
      2
    )}\n`;
    try {
      await deps.fs.writeText(path, body, { mode: STATE_FILE_MODE });
    } catch (err) {
      deps.logger.say(`could not write ${path}: ${(err as Error).message}`);
    }
    const written = await deps.runner.run(buildWriteStateArgs(ctx), { stdin: body });
    if (written.code !== 0) {
      deps.logger.say(`could not write ${IN_SESSION_PORTS_FILE} inside the session: ${written.stderr.trim()}`);
    }
  }

  return {
    path,
    // The session name is stable per repo, so without this a session that publishes nothing
    // leaves the last one's URLs in the state dir, advertised as current.
    reset: write,
    async note(entry) {
      entries.set(entry.port, { ...entry, at: stamp(deps.clock) });
      deps.logger.say(describePortEntry(entry));
      await write();
    }
  };
}

/**
 * One round, over the session's own /proc/net tables. Which candidates get published is
 * `chooseFreePorts`, the same bind probe and the same never-remap rule as the create-time
 * profile; nothing in it knows a port came from a listener rather than from HAI_PORTS.
 */
export function createPortPublisher(
  deps: { runner: Runner; net: Net; logger: Logger },
  ctx: PublishRef,
  input: { record: PortRecord; published: number[]; ephemeralLow: number }
): () => Promise<TickResult> {
  const settleOpen = createDebounce();
  const settleLocal = createDebounce();
  const decided = new Set(input.published);
  const noted = new Set<number>();

  return async function tick() {
    const read = await deps.runner.run(buildReadTablesArgs(ctx));
    const sockets = parseProcNet(read.stdout);
    // No socket at all means the output was a message rather than a table: the session is
    // still starting, is stopping, or has gone. The round is skipped and nothing is decided.
    if (sockets.length === 0) {
      return "unread";
    }
    const found = listeners(sockets);
    const open = settleOpen(found.open);
    const local = settleLocal(found.local).filter((port) => !open.includes(port));
    const pending = pendingPorts({ open, local, decided: [...decided], noted: [...noted], ephemeralLow: input.ephemeralLow });

    if (pending.ephemeral.length > 0) {
      for (const port of pending.ephemeral) {
        decided.add(port);
      }
      deps.logger.verbose(ephemeralPortsMessage(pending.ephemeral, input.ephemeralLow));
    }

    for (const port of pending.loopback) {
      noted.add(port);
      await input.record.note({ port, state: "loopback-only" });
    }
    if (pending.publish.length === 0) {
      return "checked";
    }
    for (const port of pending.publish) {
      decided.add(port);
    }
    const free = await chooseFreePorts(deps, pending.publish);
    for (const port of pending.publish) {
      if (!free.includes(port)) {
        await input.record.note({ port, state: "skipped-host-port-in-use" });
        continue;
      }
      const started = await deps.runner.run(buildSidecarArgs({ sessionName: ctx.sessionName, network: ctx.network, port, publicPorts: ctx.publicPorts }));
      await input.record.note(
        started.code === 0 ? { port, state: "published", url: `http://localhost:${port}` } : { port, state: "sidecar-failed", detail: started.stderr.trim() }
      );
    }
    return "checked";
  };
}

/**
 * The watch, for the life of the session. Claude Code's TUI owns the terminal from the
 * moment this returns, so nothing here writes to it: every decision goes to the log in the
 * state directory and to the two copies of the state. The last thing the session's own
 * logger says is anything that stopped the watch from starting at all.
 */
export async function startPortWatch(
  deps: { runner: Runner; fs: Fs; net: Net; clock: Clock; env: Env; logger: Logger },
  ctx: PublishRef,
  input: { published: number[] }
): Promise<PortWatch> {
  const idle: PortWatch = { stop: async () => undefined };
  if (isEnabled(deps.env, "HAI_NO_PORT_WATCH")) {
    deps.logger.verbose("HAI_NO_PORT_WATCH=1, so a port the session starts listening on will not be published");
    return idle;
  }
  if (!(await ensureSocatImage(deps))) {
    return idle;
  }

  let watch: PortWatch;
  try {
    watch = await beginWatch(deps, ctx, input);
  } catch (err) {
    deps.logger.say(`not watching for ports the session starts listening on: ${(err as Error).message}`);
    return idle;
  }
  deps.logger.verbose(`publishing each port the session starts listening on, from ${POLL_MS}ms to the tick; see ${portsLogPath(deps.env, ctx.sessionName)}`);
  return watch;
}

async function beginWatch(
  deps: { runner: Runner; fs: Fs; net: Net; clock: Clock; env: Env; logger: Logger },
  ctx: PublishRef,
  input: { published: number[] }
): Promise<PortWatch> {
  const log = await createWatchLog(deps, ctx.sessionName);
  const record = createPortRecord({ ...deps, logger: log.logger }, ctx);
  await record.reset();
  const tick = createPortPublisher({ runner: deps.runner, net: deps.net, logger: log.logger }, ctx, {
    record,
    published: input.published,
    ephemeralLow: await readEphemeralLow(deps)
  });

  let stopping = false;
  let wake: (() => void) | null = null;
  const loop = (async () => {
    while (!stopping) {
      await tick();
      if (stopping) {
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        void deps.clock.sleep(POLL_MS).then(resolve);
      });
    }
  })();

  return {
    async stop() {
      stopping = true;
      wake?.();
      // Awaited, so a sidecar started in the round that is in flight is still swept after.
      await loop;
      await log.flush();
    }
  };
}

/** Where everything the watch would otherwise print goes, the terminal being the TUI's. */
async function createWatchLog(deps: { fs: Fs; clock: Clock; env: Env }, sessionName: string): Promise<{ logger: Logger; flush: () => Promise<void> }> {
  const path = portsLogPath(deps.env, sessionName);
  await deps.fs.mkdirp(dirname(path), { mode: STATE_DIR_MODE });
  let tail = Promise.resolve();
  const logger = createLogger({
    isVerbose: true,
    // Appends are queued behind one another rather than awaited, because Logger is
    // synchronous; a failed one is dropped, the log being the least of what is at stake.
    write: (text) => {
      tail = tail.then(() => deps.fs.appendText(path, `${stamp(deps.clock)} ${text}`, { mode: STATE_FILE_MODE })).catch(() => undefined);
    }
  });
  return { logger, flush: () => tail };
}

function stamp(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() || "no reason given";
}

export type TickResult = "unread" | "checked";

export type PortState = "published" | "skipped-host-port-in-use" | "loopback-only" | "sidecar-failed";

export interface PortEntry {
  port: number;
  state: PortState;
  url?: string;
  detail?: string;
  /** Set as the entry is recorded, not by the caller. */
  at?: string;
}

export interface PendingPorts {
  publish: number[];
  loopback: number[];
  /** In the host's ephemeral range: decided, so they are not revisited, and left unpublished. */
  ephemeral: number[];
}

export interface PortRecord {
  path: string;
  /** The state as this session starts: empty, so the last session's URLs stop being advertised. */
  reset(): Promise<void>;
  note(entry: PortEntry): Promise<void>;
}

export interface PortWatch {
  /** Idempotent, and must be awaited before the sidecars are swept. */
  stop(): Promise<void>;
}

export interface SessionRef {
  sessionName: string;
  containerUser: string;
}

export interface PublishRef extends SessionRef {
  network: string;
  /** 0.0.0.0 rather than loopback for each sidecar's mapping, which HAI_PORTS_PUBLIC=1 asks for. */
  publicPorts: boolean;
}
