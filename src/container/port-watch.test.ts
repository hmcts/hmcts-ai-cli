import { describe, expect, it } from "vitest";
import { createFakeFs, createFakeSeams, type FakeSeams, FIXED_NOW, type RunResponder } from "../__fixtures__/fake-seams.js";
import type { Clock } from "../system/clock.js";
import {
  buildReadTablesArgs,
  buildSidecarArgs,
  buildSweepListArgs,
  buildSweepRemoveArgs,
  buildWriteStateArgs,
  createPortPublisher,
  createPortRecord,
  describePortEntry,
  ensureSocatImage,
  IN_SESSION_PORTS_FILE,
  type PortEntry,
  pendingPorts,
  portsLogPath,
  portsStatePath,
  SESSION_LABEL,
  SOCAT_IMAGE,
  sidecarName,
  socatMissingMessage,
  startPortWatch,
  sweepIds,
  sweepSidecars
} from "./port-watch.js";

const HOME = "/home/linus";
const SESSION = "hai-hmcts-7293fcec";
const CTX = { sessionName: SESSION, containerUser: "hmcts", network: "hai", publicPorts: false };

/** Linux's default low bound, which is what a host that publishes no range is read as. */
const EPHEMERAL_LOW = 32768;
const PORTS_DIR = `${HOME}/.local/state/hai/ports`;
const STATE_FILE = `${PORTS_DIR}/${SESSION}.ports.json`;
const LOG_FILE = `${PORTS_DIR}/${SESSION}.log`;

const table = (...rows: string[]) =>
  ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode", ...rows, ""].join("\n");

/** One listening socket, as /proc/net/tcp prints it. */
const row = (address: string, port: number, state = "0A") =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0`;

const OPEN_8111 = table(row("00000000", 8111));
const LOOPBACK_9876 = table(row("0100007F", 9876));

/** A host where every docker call works and the session's table holds `text`. */
const respondWith =
  (text: string): RunResponder =>
  (argv) =>
    argv.includes("cat") ? { code: 0, stdout: text } : { code: 0, stdout: "f00dcafe1234\n" };

const seamsIn = (over: Partial<Parameters<typeof createFakeSeams>[0]> = {}) => createFakeSeams({ env: { HOME }, ...over });

const publisherIn = (seams: FakeSeams, published: number[] = [], ctx = CTX) => {
  const record = createPortRecord(seams, ctx);
  return createPortPublisher(seams, ctx, { record, published, ephemeralLow: EPHEMERAL_LOW });
};

const stateOf = (seams: FakeSeams): { ports: PortEntry[] } => JSON.parse(seams.fs.store.get(STATE_FILE) ?? '{"ports":[]}');

/** A real tick, one millisecond long, so the watch loop runs for as long as an assertion needs. */
const fastClock: Clock = { now: () => FIXED_NOW, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) };

async function until(settled: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !settled(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("sidecarName", () => {
  it("should name a sidecar after its session and port, so a sweep is not the only way to find one", () => {
    // Act / Assert
    expect(sidecarName(SESSION, 8111)).toBe("hai-hmcts-7293fcec-port-8111");
  });
});

describe("buildSidecarArgs", () => {
  const sidecar = (publicPorts = false) => buildSidecarArgs({ sessionName: SESSION, network: "hai", port: 8111, publicPorts }).join(" ");

  it("should build the whole socat argv", () => {
    // Act / Assert
    expect(sidecar()).toMatchInlineSnapshot(
      `"docker run -d --rm --name hai-hmcts-7293fcec-port-8111 --network hai -p 127.0.0.1:8111:8111 --label hai.session=hai-hmcts-7293fcec alpine/socat TCP-LISTEN:8111,fork,reuseaddr TCP:hai-hmcts-7293fcec:8111"`
    );
  });

  it.each<[string, string]>([
    ["the host mapping at the same number, never a different one", "-p 127.0.0.1:8111:8111"],
    ["the session's own network, so container-name DNS resolves", "--network hai"],
    ["the label the sweep matches on", `--label ${SESSION_LABEL}=${SESSION}`],
    ["a forward to the session by name", `TCP:${SESSION}:8111`],
    ["--rm, so a sidecar whose socat dies leaves nothing behind", "--rm"]
  ])("should carry %s", (_name, expected) => {
    // Act / Assert
    expect(sidecar()).toContain(expected);
  });

  it("should bind to 0.0.0.0 only when HAI_PORTS_PUBLIC asked for it", () => {
    // Act / Assert
    expect(sidecar(true)).toContain("-p 8111:8111");
    expect(sidecar(true)).not.toContain("127.0.0.1");
  });
});

describe("the exec argv", () => {
  it("should read both tables in one exec", () => {
    // Act / Assert
    expect(buildReadTablesArgs(CTX)).toEqual(["docker", "exec", "--user", "hmcts", SESSION, "cat", "/proc/net/tcp", "/proc/net/tcp6"]);
  });

  it("should write the state inside the session as the session's own user", () => {
    // Act / Assert
    expect(buildWriteStateArgs(CTX)).toEqual(["docker", "exec", "-i", "--user", "hmcts", SESSION, "sh", "-c", `cat > ${IN_SESSION_PORTS_FILE}`]);
  });
});

describe("the sweep argv", () => {
  it("should list by label alone, so a sidecar is found however it was named", () => {
    // Act / Assert
    expect(buildSweepListArgs(SESSION)).toEqual(["docker", "ps", "-aq", "--filter", `label=${SESSION_LABEL}=${SESSION}`]);
  });

  it("should remove every id in one call", () => {
    // Act / Assert
    expect(buildSweepRemoveArgs(["abc", "def"])).toEqual(["docker", "rm", "-f", "abc", "def"]);
  });

  it.each<[string, string, string[]]>([
    ["one id", "abc123\n", ["abc123"]],
    ["several", "abc123\ndef456\n", ["abc123", "def456"]],
    ["no sidecars at all", "", []],
    ["blank lines and padding", "\n  abc123  \n\n", ["abc123"]]
  ])("should read %s from docker ps", (_name, stdout, expected) => {
    // Act / Assert
    expect(sweepIds(stdout)).toEqual(expected);
  });
});

describe("the state paths", () => {
  it.each<[string, Record<string, string>, string]>([
    ["HOME", { HOME }, `${PORTS_DIR}/${SESSION}`],
    ["XDG_STATE_HOME", { XDG_STATE_HOME: "/state" }, `/state/hai/ports/${SESSION}`]
  ])("should keep the log and the state under %s", (_name, env, prefix) => {
    // Act / Assert
    expect(portsLogPath(env, SESSION)).toBe(`${prefix}.log`);
    expect(portsStatePath(env, SESSION)).toBe(`${prefix}.ports.json`);
  });
});

describe("pendingPorts", () => {
  const over = (input: Partial<Parameters<typeof pendingPorts>[0]>): Parameters<typeof pendingPorts>[0] => ({
    open: [],
    local: [],
    decided: [],
    noted: [],
    ephemeralLow: EPHEMERAL_LOW,
    ...input
  });

  it.each<[string, Parameters<typeof pendingPorts>[0], number[], number[], number[]]>([
    ["a port that has just appeared", over({ open: [8111] }), [8111], [], []],
    ["a port decided on an earlier tick", over({ open: [8111], decided: [8111] }), [], [], []],
    ["a port already published at create time", over({ open: [3000, 8111], decided: [3000] }), [8111], [], []],
    ["a loopback-only listener", over({ local: [9876] }), [], [9876], []],
    ["a loopback-only listener already reported", over({ local: [9876], noted: [9876] }), [], [], []],
    ["a loopback-only listener on a port that was published", over({ local: [8111], decided: [8111] }), [], [], []],
    ["nothing listening", over({ decided: [8111], noted: [9876] }), [], [], []],
    ["a Testcontainers mapping in the ephemeral range", over({ open: [41235] }), [], [], [41235]],
    ["the lowest ephemeral port, the bound being inclusive", over({ open: [32768] }), [], [], [32768]],
    ["the port just below the bound", over({ open: [32767] }), [32767], [], []],
    ["an ephemeral port already decided", over({ open: [41235], decided: [41235] }), [], [], []],
    ["a loopback-only ephemeral listener, whose 0.0.0.0 hint would be wrong", over({ local: [41235] }), [], [], [41235]],
    ["a host whose ephemeral range starts lower", over({ open: [15000], ephemeralLow: 10000 }), [], [], [15000]]
  ])("should decide %s", (_name, input, publish, loopback, ephemeral) => {
    // Act / Assert
    expect(pendingPorts(input)).toEqual({ publish, loopback, ephemeral });
  });
});

describe("describePortEntry", () => {
  it.each<[string, PortEntry, string]>([
    [
      "a published port with the URL it answers at",
      { port: 8111, state: "published", url: "http://localhost:8111" },
      "published 8111 -> http://localhost:8111"
    ],
    ["a host port in use, and why it is not moved", { port: 3000, state: "skipped-host-port-in-use" }, "OAuth redirect"],
    ["a loopback-only listener, with the fix", { port: 9876, state: "loopback-only" }, "Bind it to 0.0.0.0"],
    [
      "a sidecar that would not start, with the reason",
      { port: 8111, state: "sidecar-failed", detail: "no such image" },
      "could not publish 8111: no such image"
    ],
    ["a sidecar whose docker run timed out, which says nothing at all", { port: 8111, state: "sidecar-failed" }, "could not publish 8111: no reason given"],
    [
      "a sidecar failure the daemon wrote several lines about",
      { port: 8111, state: "sidecar-failed", detail: "docker: no such image\nSee 'docker run --help'\n" },
      "could not publish 8111: docker: no such image"
    ]
  ])("should describe %s", (_name, entry, expected) => {
    // Act
    const described = describePortEntry(entry);

    // Assert
    expect(described).toContain(expected);
    expect(described).not.toContain("\n");
  });
});

describe("ensureSocatImage", () => {
  it("should use the image already on the host without pulling it again", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 0 }) });

    // Act / Assert
    expect(await ensureSocatImage(seams)).toBe(true);
    expect(seams.runner.calls.map((call) => call.argv[1])).toEqual(["image"]);
  });

  it("should pull it once when it is missing", async () => {
    // Arrange
    const seams = seamsIn({
      env: { HOME, HAI_VERBOSE: "1" },
      respond: (argv) => (argv[1] === "image" ? { code: 1, stderr: "No such image" } : { code: 0 })
    });

    // Act / Assert
    expect(await ensureSocatImage(seams)).toBe(true);
    expect(seams.runner.calls.at(-1)?.argv).toEqual(["docker", "pull", SOCAT_IMAGE]);
    expect(seams.lines.join("")).toContain(`pulled ${SOCAT_IMAGE}`);
  });

  it("should explain a pull that fails in one line, and not fail the session", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 1, stderr: "Error response from daemon: unauthorized\nsee docker login\n" }) });

    // Act
    const available = await ensureSocatImage(seams);

    // Assert
    expect(available).toBe(false);
    expect(seams.lines).toHaveLength(1);
    expect(seams.lines[0]).toContain("Error response from daemon: unauthorized");
    expect(seams.lines[0]).toContain(`docker pull ${SOCAT_IMAGE}`);
  });

  it("should still explain itself when the daemon said nothing at all", () => {
    // Act / Assert
    expect(socatMissingMessage("")).toContain("no reason given");
  });
});

describe("sweepSidecars", () => {
  it("should remove every container carrying the session's label", async () => {
    // Arrange
    const seams = seamsIn({ env: { HOME, HAI_VERBOSE: "1" }, respond: (argv) => ({ code: 0, stdout: argv[1] === "ps" ? "abc123\ndef456\n" : "" }) });

    // Act
    const removed = await sweepSidecars(seams, SESSION);

    // Assert
    expect(removed).toBe(2);
    expect(seams.runner.calls.at(-1)?.argv).toEqual(["docker", "rm", "-f", "abc123", "def456"]);
    expect(seams.lines.join("")).toContain("removed 2 published-port container(s)");
  });

  it("should do nothing when the session left none", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 0, stdout: "" }) });

    // Act
    const removed = await sweepSidecars(seams, SESSION);

    // Assert
    expect(removed).toBe(0);
    expect(seams.runner.calls).toHaveLength(1);
  });

  it("should treat a daemon that cannot be asked as nothing to sweep", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" }) });

    // Act / Assert
    expect(await sweepSidecars(seams, SESSION)).toBe(0);
    expect(seams.runner.calls).toHaveLength(1);
  });

  it("should say so when a sidecar will not be removed", async () => {
    // Arrange
    const seams = seamsIn({
      respond: (argv) => (argv[1] === "ps" ? { code: 0, stdout: "abc123\n" } : { code: 1, stderr: "permission denied" })
    });

    // Act
    const removed = await sweepSidecars(seams, SESSION);

    // Assert
    expect(removed).toBe(0);
    expect(seams.lines.join("")).toContain("could not remove 1 published-port container(s)");
  });
});

describe("createPortRecord", () => {
  it("should write the state to the state directory and into the session", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 0 }) });
    const record = createPortRecord(seams, CTX);

    // Act
    await record.note({ port: 8111, state: "published", url: "http://localhost:8111" });

    // Assert
    expect(stateOf(seams).ports).toEqual([{ port: 8111, state: "published", url: "http://localhost:8111", at: "2026-10-21T09:00:00.000Z" }]);
    const inside = seams.runner.calls.find((call) => call.argv.includes(`cat > ${IN_SESSION_PORTS_FILE}`));
    expect(inside?.opts.stdin).toContain('"port": 8111');
  });

  it("should write an empty state on reset, so a previous session's URLs stop being advertised", async () => {
    // Arrange
    const seams = seamsIn({ files: { [STATE_FILE]: '{"ports":[{"port":5062,"state":"published"}]}' }, respond: () => ({ code: 0 }) });
    const record = createPortRecord(seams, CTX);

    // Act
    await record.reset();

    // Assert
    expect(JSON.parse(seams.fs.store.get(STATE_FILE)!)).toEqual({ session: SESSION, updated: "2026-10-21T09:00:00.000Z", ports: [] });
    expect(seams.lines).toEqual([]);
  });

  it("should keep every port decided so far, in port order", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 0 }) });
    const record = createPortRecord(seams, CTX);

    // Act
    await record.note({ port: 9200, state: "published", url: "http://localhost:9200" });
    await record.note({ port: 3000, state: "skipped-host-port-in-use" });

    // Assert
    expect(stateOf(seams).ports.map((entry) => entry.port)).toEqual([3000, 9200]);
  });

  it("should carry on when the state file cannot be written", async () => {
    // Arrange
    const fs = { ...createFakeFs(), writeText: async () => Promise.reject(new Error("read-only file system")) };
    const seams = seamsIn({ fs, respond: () => ({ code: 0 }) });
    const record = createPortRecord(seams, CTX);

    // Act
    await record.note({ port: 8111, state: "published", url: "http://localhost:8111" });

    // Assert
    expect(seams.lines.join("")).toContain("read-only file system");
  });

  it("should carry on when the copy inside the session cannot be written", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 1, stderr: "container is not running" }) });
    const record = createPortRecord(seams, CTX);

    // Act
    await record.note({ port: 8111, state: "published", url: "http://localhost:8111" });

    // Assert
    expect(seams.lines.join("")).toContain(`could not write ${IN_SESSION_PORTS_FILE}`);
    expect(stateOf(seams).ports).toHaveLength(1);
  });
});

describe("createPortPublisher", () => {
  it("should skip a round it cannot read a table in, and decide nothing", async () => {
    // Arrange
    const seams = seamsIn({ respond: () => ({ code: 1, stderr: "Error: No such container" }) });
    const tick = publisherIn(seams);

    // Act / Assert
    expect(await tick()).toBe("unread");
    expect(seams.runner.calls).toHaveLength(1);
  });

  it("should publish a port once the debounce has settled, and not before", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(OPEN_8111) });
    const tick = publisherIn(seams);

    // Act
    expect(await tick()).toBe("checked");
    const beforeSettling = seams.runner.calls.some((call) => call.argv.includes("alpine/socat"));
    await tick();

    // Assert
    expect(beforeSettling).toBe(false);
    expect(seams.runner.calls.some((call) => call.argv.includes(`TCP:${SESSION}:8111`))).toBe(true);
    expect(stateOf(seams).ports).toEqual([{ port: 8111, state: "published", url: "http://localhost:8111", at: "2026-10-21T09:00:00.000Z" }]);
  });

  it("should decide a port once and never attempt it again", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(OPEN_8111) });
    const tick = publisherIn(seams);

    // Act
    await tick();
    await tick();
    await tick();
    await tick();

    // Assert
    expect(seams.runner.calls.filter((call) => call.argv.includes("alpine/socat"))).toHaveLength(1);
  });

  it("should leave a port the create-time profile already published alone", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(OPEN_8111) });
    const tick = publisherIn(seams, [8111]);

    // Act
    await tick();
    await tick();

    // Assert
    expect(seams.runner.calls.some((call) => call.argv.includes("alpine/socat"))).toBe(false);
    expect(stateOf(seams).ports).toEqual([]);
  });

  it("should skip a port whose host number is taken rather than move it", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(OPEN_8111), portsInUse: [8111] });
    const tick = publisherIn(seams);

    // Act
    await tick();
    await tick();

    // Assert
    expect(seams.runner.calls.some((call) => call.argv.includes("alpine/socat"))).toBe(false);
    expect(stateOf(seams).ports).toEqual([{ port: 8111, state: "skipped-host-port-in-use", at: "2026-10-21T09:00:00.000Z" }]);
  });

  it("should report a loopback-only listener once, with the hint, and attempt no sidecar", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(LOOPBACK_9876) });
    const tick = publisherIn(seams);

    // Act
    await tick();
    await tick();
    await tick();

    // Assert
    expect(seams.runner.calls.some((call) => call.argv.includes("alpine/socat"))).toBe(false);
    expect(stateOf(seams).ports).toEqual([{ port: 9876, state: "loopback-only", at: "2026-10-21T09:00:00.000Z" }]);
    expect(seams.lines.filter((line) => line.includes("9876"))).toHaveLength(1);
  });

  it("should record a sidecar that would not start, with the daemon's reason", async () => {
    // Arrange
    const seams = seamsIn({
      respond: (argv) => {
        if (argv.includes("cat")) {
          return { code: 0, stdout: OPEN_8111 };
        }
        return argv.includes("alpine/socat") ? { code: 125, stderr: "docker: Error response from daemon: no such image\n" } : { code: 0 };
      }
    });
    const tick = publisherIn(seams);

    // Act
    await tick();
    await tick();

    // Assert
    expect(stateOf(seams).ports).toEqual([
      { port: 8111, state: "sidecar-failed", detail: "docker: Error response from daemon: no such image", at: "2026-10-21T09:00:00.000Z" }
    ]);
  });

  it("should bind a sidecar to loopback, unless the session asked for public ports", async () => {
    // Arrange
    const loopback = seamsIn({ respond: respondWith(OPEN_8111) });
    const open = seamsIn({ respond: respondWith(OPEN_8111) });

    // Act
    for (const tick of [publisherIn(loopback), publisherIn(open, [], { ...CTX, publicPorts: true })]) {
      await tick();
      await tick();
    }

    // Assert
    expect(loopback.runner.calls.some((call) => call.argv.join(" ").includes("-p 127.0.0.1:8111:8111"))).toBe(true);
    expect(open.runner.calls.some((call) => call.argv.join(" ").includes("-p 8111:8111"))).toBe(true);
  });

  it("should leave an ephemeral-range listener alone, so Testcontainers cannot accumulate sidecars", async () => {
    // Arrange: one docker-proxy mapping per inner container, each on a random high port
    const churn = table(row("00000000", 41235), row("00000000", 41236));
    const seams = seamsIn({ env: { HOME, HAI_VERBOSE: "1" }, respond: respondWith(churn) });
    const tick = publisherIn(seams);

    // Act
    await tick();
    await tick();
    await tick();

    // Assert
    expect(seams.runner.calls.some((call) => call.argv.includes("alpine/socat"))).toBe(false);
    expect(stateOf(seams).ports).toEqual([]);
    expect(seams.lines.filter((line) => line.includes("41235"))).toHaveLength(1);
    expect(seams.lines.join("")).toContain("not publishing 41235, 41236: at or above 32768");
  });

  it("should publish a port a nested container is forwarding, which is the cftlib case", async () => {
    // Arrange: docker-proxy inside the session listens on 0.0.0.0 for each inner -p
    const nested = table(row("00000000", 5062), row("00000000", 4452), row("0100007F", 9876));
    const seams = seamsIn({ respond: respondWith(nested) });
    const tick = publisherIn(seams);

    // Act
    await tick();
    await tick();

    // Assert
    expect(
      stateOf(seams)
        .ports.filter((entry) => entry.state === "published")
        .map((entry) => entry.port)
    ).toEqual([4452, 5062]);
  });
});

describe("startPortWatch", () => {
  const sidecarUp = (seams: FakeSeams) => seams.runner.calls.some((call) => call.argv.includes(`TCP:${SESSION}:8111`));
  const reads = (seams: FakeSeams) => seams.runner.calls.filter((call) => call.argv.includes("cat")).length;

  it("should publish a port the session starts listening on, and say nothing on the terminal", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(OPEN_8111), clock: fastClock });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await until(() => sidecarUp(seams));
    await watch.stop();

    // Assert
    expect(sidecarUp(seams)).toBe(true);
    expect(seams.lines).toEqual([]);
    expect(seams.fs.store.get(LOG_FILE)).toContain("published 8111 -> http://localhost:8111");
    expect(seams.fs.dirs.has(PORTS_DIR)).toBe(true);
  });

  it("should empty the state as it starts, a session that publishes nothing leaving no stale URLs", async () => {
    // Arrange: the previous session for this repo published 5062, and this one listens on nothing
    const seams = seamsIn({
      files: { [STATE_FILE]: '{"ports":[{"port":5062,"state":"published","url":"http://localhost:5062"}]}' },
      respond: respondWith(table())
    });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await watch.stop();

    // Assert
    expect(stateOf(seams).ports).toEqual([]);
    expect(seams.lines).toEqual([]);
  });

  it("should stop reading the session once the session has ended", async () => {
    // Arrange
    const seams = seamsIn({ respond: respondWith(OPEN_8111), clock: fastClock });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await until(() => sidecarUp(seams));
    await watch.stop();
    const settled = reads(seams);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert
    expect(reads(seams)).toBe(settled);
  });

  it("should stop without waiting for the tick when the session ends mid-round", async () => {
    // Arrange
    const holder: { watch?: { stop(): Promise<void> } } = {};
    let read = 0;
    const seams = seamsIn({
      respond: (argv) => {
        if (!argv.includes("cat")) {
          return { code: 0, stdout: "f00dcafe1234\n" };
        }
        read += 1;
        if (read === 2) {
          void holder.watch?.stop();
        }
        return { code: 0, stdout: OPEN_8111 };
      },
      clock: fastClock
    });

    // Act
    holder.watch = await startPortWatch(seams, CTX, { published: [] });
    await until(() => sidecarUp(seams));
    await holder.watch.stop();

    // Assert
    expect(read).toBe(2);
    expect(sidecarUp(seams)).toBe(true);
  });

  it("should carry on when the log itself cannot be written", async () => {
    // Arrange
    const fs = { ...createFakeFs(), appendText: async () => Promise.reject(new Error("no space left on device")) };
    const seams = seamsIn({ fs, respond: respondWith(OPEN_8111), clock: fastClock });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await until(() => sidecarUp(seams));
    await watch.stop();

    // Assert
    expect(sidecarUp(seams)).toBe(true);
    expect(seams.lines).toEqual([]);
  });

  it("should do nothing at all with HAI_NO_PORT_WATCH=1", async () => {
    // Arrange
    const seams = seamsIn({ env: { HOME, HAI_NO_PORT_WATCH: "1", HAI_VERBOSE: "1" }, respond: respondWith(OPEN_8111) });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await watch.stop();

    // Assert
    expect(seams.runner.calls).toEqual([]);
    expect(seams.lines.join("")).toContain("HAI_NO_PORT_WATCH=1");
  });

  it("should not watch when socat is unavailable, and not fail the session", async () => {
    // Arrange
    const seams = seamsIn({ respond: (argv) => (argv[1] === "image" || argv[1] === "pull" ? { code: 1, stderr: "unauthorized" } : { code: 0 }) });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await watch.stop();

    // Assert
    expect(seams.runner.calls.some((call) => call.argv.includes("cat"))).toBe(false);
    expect(seams.lines.join("")).toContain(SOCAT_IMAGE);
  });

  it("should give up on the watch rather than the session when the log cannot be opened", async () => {
    // Arrange
    const fs = { ...createFakeFs(), mkdirp: async () => Promise.reject(new Error("permission denied")) };
    const seams = seamsIn({ fs, respond: respondWith(OPEN_8111) });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await watch.stop();

    // Assert
    expect(seams.lines.join("")).toContain("not watching for ports the session starts listening on: permission denied");
    expect(reads(seams)).toBe(0);
  });

  it("should name the log it is writing to under HAI_VERBOSE", async () => {
    // Arrange
    const seams = seamsIn({ env: { HOME, HAI_VERBOSE: "1" }, respond: respondWith(OPEN_8111), clock: fastClock });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await watch.stop();

    // Assert
    expect(seams.lines.join("")).toContain(LOG_FILE);
  });

  it("should keep watching, so a server started later in the session is still published", async () => {
    // Arrange: nothing is listening for the first two rounds
    let round = 0;
    const seams = seamsIn({
      respond: (argv) => {
        if (argv.includes("cat")) {
          round += 1;
          return { code: 0, stdout: round <= 2 ? table() : OPEN_8111 };
        }
        return { code: 0, stdout: "f00dcafe1234\n" };
      },
      clock: fastClock
    });

    // Act
    const watch = await startPortWatch(seams, CTX, { published: [] });
    await until(() => sidecarUp(seams));
    await watch.stop();

    // Assert
    expect(round).toBeGreaterThan(3);
    expect(sidecarUp(seams)).toBe(true);
  });
});
