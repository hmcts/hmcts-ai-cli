import { dirname, join } from "node:path";
import { createLogger, type Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import { type Env, isEnabled } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Net } from "../system/net.js";
import type { Runner } from "../system/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, statePath } from "../system/state-dir.js";
import { DOCKER_BIN } from "./docker-args.js";
import { type LockFile, parseLock, pidAlive } from "./lock.js";
import { chooseFreePorts, ephemeralPortsMessage, publishArg, readEphemeralLow } from "./ports.js";
import { createDebounce, listeners, parseProcNet } from "./proc-net.js";

/**
 * One container per port, forwarding to the session over the user-defined network. Docker
 * mappings are create-time only, so a new listener can only be published by a new container.
 */
export const SOCAT_IMAGE = "alpine/socat";

/** What the sweep matches on. The session container deliberately does not carry it. */
export const SESSION_LABEL = "hai.session";

export const POLL_MS = 2000;
export const PULL_TIMEOUT_MS = 120_000;

/** So the agent in the session can discover the URLs its own servers are reachable at. */
export const IN_SESSION_PORTS_FILE = "/tmp/hai-ports.json";

const PROC_NET_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

/** How the daemon refuses a `-p` whose host port went between the probe and the sidecar's run. */
const ALLOCATED = /port is already allocated/i;

export function sidecarName(session: string, port: number): string {
  return `${session}-port-${port}`;
}

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

export function buildPublishedListArgs(sessionName: string): string[] {
  return [DOCKER_BIN, "ps", "--filter", `label=${SESSION_LABEL}=${sessionName}`, "--format", "{{.Names}}"];
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

/** The ports a sidecar already publishes, read off the sidecars' own names. */
export function publishedPorts(sessionName: string, stdout: string): number[] {
  const prefix = `${sessionName}-port-`;
  return sweepIds(stdout)
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)));
}

export function watchLockPath(env: Env, sessionName: string): string {
  return join(statePath(env, "ports"), `${sessionName}.watch.json`);
}

export function portsLogPath(env: Env, sessionName: string): string {
  return join(statePath(env, "ports"), `${sessionName}.log`);
}

export function portsStatePath(env: Env, sessionName: string): string {
  return join(statePath(env, "ports"), `${sessionName}.ports.json`);
}

/** Which of the ports now listening still need a decision. A port is decided once and never revisited. */
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
      return ALLOCATED.test(entry.detail ?? "")
        ? `could not publish ${entry.port}: it was free moments earlier, when hai checked, and something else took it before the sidecar could bind it.`
        : `could not publish ${entry.port}: ${firstLine(entry.detail ?? "")}`;
  }
}

export function socatMissingMessage(stderr: string): string {
  return (
    `${SOCAT_IMAGE} is not available (${firstLine(stderr)}), so a port a server in the session starts will not be published on the host. ` +
    `Everything else in the session works; pull it once with docker pull ${SOCAT_IMAGE}.`
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
 * Every sidecar this session's name is on, removed. One outliving its session holds a host
 * port whose server is gone, so this runs before a container is created and after it ends.
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

/** The log and the two copies of the state: one in the state directory, one inside the session. */
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
 * `chooseFreePorts`: a bind probe on the host, and a clash skipped rather than remapped.
 */
export function createPortPublisher(
  deps: { runner: Runner; net: Net; logger: Logger },
  ctx: PublishRef,
  input: { record: PortRecord; ephemeralLow: number; published?: number[] }
): () => Promise<TickResult> {
  const settleOpen = createDebounce();
  const settleLocal = createDebounce();
  const decided = new Set<number>(input.published ?? []);
  const noted = new Set<number>();

  return async function tick() {
    const read = await deps.runner.run(buildReadTablesArgs(ctx));
    const sockets = parseProcNet(read.stdout);
    // No socket at all means the output was a message, not a table: the session is starting, stopping or gone.
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
 * The watch, for as long as any session is attached. One session holds the watcher lock and
 * publishes; the others stand by and take it the moment its holder lets go, so the ports keep
 * being published after the session that started them has gone. Claude Code's TUI owns the
 * terminal from the moment this returns, so every decision goes to the log rather than to it.
 */
export async function startPortWatch(deps: WatchDeps, ctx: PublishRef): Promise<PortWatch> {
  const idle: PortWatch = { stop: async () => undefined };
  if (isEnabled(deps.env, "HAI_NO_PORT_WATCH")) {
    deps.logger.verbose("HAI_NO_PORT_WATCH=1, so a port the session starts listening on will not be published");
    return idle;
  }
  if (!(await ensureSocatImage(deps))) {
    return idle;
  }

  const lockPath = watchLockPath(deps.env, ctx.sessionName);
  let active: PortWatch | null = null;
  let holding = false;
  let stopping = false;
  let wake: (() => void) | null = null;

  async function attempt(): Promise<boolean> {
    try {
      if (!(await takeWatchLock(deps, { path: lockPath, sessionName: ctx.sessionName }))) {
        return false;
      }
      holding = true;
      active = await beginWatch(deps, ctx);
      deps.logger.verbose(
        `publishing each port the session starts listening on, from ${POLL_MS}ms to the tick; see ${portsLogPath(deps.env, ctx.sessionName)}`
      );
    } catch (err) {
      deps.logger.say(`not watching for ports the session starts listening on: ${(err as Error).message}`);
    }
    return true;
  }

  const standby =
    (await attempt()) === true
      ? Promise.resolve()
      : (async () => {
          deps.logger.verbose("another session is publishing ports; this one takes over if it ends first");
          while (!stopping) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              void deps.clock.sleep(POLL_MS).then(resolve);
            });
            if (!stopping && (await attempt())) {
              return;
            }
          }
        })();

  return {
    async stop() {
      stopping = true;
      wake?.();
      await standby;
      await active?.stop();
      if (holding) {
        holding = false;
        await releaseWatchLock(deps, lockPath);
      }
    }
  };
}

/** Whether this session now holds the lock: one atomic create, a dead holder's file reclaimed. */
async function takeWatchLock(deps: WatchDeps, input: { path: string; sessionName: string }): Promise<boolean> {
  await deps.fs.mkdirp(dirname(input.path), { mode: STATE_DIR_MODE });
  const body = `${JSON.stringify({ pid: deps.pid, container: input.sessionName, at: deps.clock.now() })}\n`;
  if (await deps.fs.createExclusive(input.path, body, { mode: STATE_FILE_MODE })) {
    return true;
  }
  const held = parseLock(await deps.fs.readText(input.path));
  if (held !== null && (await pidAlive(deps, held.pid)) !== false) {
    return false;
  }
  await deps.fs.remove(input.path);
  return deps.fs.createExclusive(input.path, body, { mode: STATE_FILE_MODE });
}

async function releaseWatchLock(deps: WatchDeps, path: string): Promise<void> {
  const held: LockFile | null = parseLock(await deps.fs.readText(path));
  if (held?.pid === deps.pid) {
    await deps.fs.remove(path);
  }
}

async function beginWatch(deps: WatchDeps, ctx: PublishRef): Promise<PortWatch> {
  const log = await createWatchLog(deps, ctx.sessionName);
  const record = createPortRecord({ ...deps, logger: log.logger }, ctx);
  // Sidecars outlive the session that published them, so a successor adopts them rather than finding its own ports taken.
  const listed = await deps.runner.run(buildPublishedListArgs(ctx.sessionName));
  const published = listed.code === 0 ? publishedPorts(ctx.sessionName, listed.stdout) : [];
  await record.reset();
  for (const port of published) {
    await record.note({ port, state: "published", url: `http://localhost:${port}` });
  }
  const tick = createPortPublisher({ runner: deps.runner, net: deps.net, logger: log.logger }, ctx, {
    record,
    ephemeralLow: await readEphemeralLow(deps),
    published
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
    // Queued rather than awaited, because Logger is synchronous.
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

export interface WatchDeps {
  runner: Runner;
  fs: Fs;
  net: Net;
  clock: Clock;
  env: Env;
  logger: Logger;
  pid: number;
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
