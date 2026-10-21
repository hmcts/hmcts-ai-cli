import { describe, expect, it } from "vitest";
import { addressKind, createDebounce, listeners, type ProcNetSocket, parseProcNet } from "./proc-net.js";

/**
 * Captured from a container running `python3 -m http.server 8111 --bind 0.0.0.0` and
 * `--bind 127.0.0.1` on 9876: 00000000:1FAF is 0.0.0.0:8111 and 0100007F:2694 is
 * 127.0.0.1:9876, both in state 0A.
 */
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2694 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 63401415 1 0000000000000000 100 0 0 10 0
   1: 00000000:1FAF 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 63390650 1 0000000000000000 100 0 0 10 0
`;

/** Captured from cftlib's XUI container, whose Node server listens on :: port 0BB8 (3000). */
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   100        0 31500707 1 0000000000000000 100 0 0 10 0
`;

/** A connection out, plus a line the kernel cut short, which is every round that races a write. */
const NOISE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F91
   2: not-a-socket
`;

const socket = (address: string, port: number, state = "0A"): ProcNetSocket => ({ address, port, state });

describe("parseProcNet", () => {
  it("should read every socket in a real tcp table", () => {
    // Act
    const sockets = parseProcNet(TCP);

    // Assert
    expect(sockets).toEqual([socket("0100007F", 9876), socket("00000000", 8111)]);
  });

  it("should read a tcp6 table's longer addresses", () => {
    // Act / Assert
    expect(parseProcNet(TCP6)).toEqual([socket("00000000000000000000000000000000", 3000)]);
  });

  it.each<[string, string, number]>([
    ["a header on its own", "  sl  local_address rem_address   st\n", 0],
    ["an empty table", "", 0],
    ["lines too short to be sockets", NOISE, 1]
  ])("should skip %s", (_name, text, expected) => {
    // Act / Assert
    expect(parseProcNet(text)).toHaveLength(expected);
  });

  it("should upper-case a lower-case address, which is how some kernels print it", () => {
    // Act
    const sockets = parseProcNet(`h\n 0: 0100007f:1f90 00000000:0000 0a 0 0 0 0 0 0 0 0\n`);

    // Assert
    expect(sockets[0]).toEqual({ address: "0100007F", port: 8080, state: "0A" });
  });
});

describe("addressKind", () => {
  it.each<[string, string, string]>([
    ["0.0.0.0", "00000000", "reachable"],
    ["a container's own address", "0C00110A", "reachable"],
    ["127.0.0.1", "0100007F", "loopback"],
    ["127.0.0.53, the resolver stub", "3500007F", "loopback"],
    ["::", "00000000000000000000000000000000", "reachable"],
    ["::1", "00000000000000000000000001000000", "loopback"],
    ["::ffff:127.0.0.1", "0000000000000000FFFF00000100007F", "loopback"],
    ["::ffff:192.168.0.1", "0000000000000000FFFF0000C0A80001", "reachable"],
    ["a routable IPv6 address", "0D0010200000000000000000D1000000", "reachable"],
    ["an address too short to be either", "0100", "reachable"]
  ])("should call %s %s", (_name, hex, expected) => {
    // Act / Assert
    expect(addressKind(hex)).toBe(expected);
  });
});

describe("listeners", () => {
  it("should split the reachable listeners from the loopback-only ones", () => {
    // Act
    const found = listeners([...parseProcNet(TCP), ...parseProcNet(TCP6)]);

    // Assert
    expect(found).toEqual({ open: [3000, 8111], local: [9876] });
  });

  it.each<[string, ProcNetSocket[], number[], number[]]>([
    ["a socket that is connected rather than listening", [socket("00000000", 8111, "01")], [], []],
    ["a privileged port", [socket("00000000", 80)], [], []],
    ["the same port in both tables", [socket("00000000", 8111), socket("00000000000000000000000000000000", 8111)], [8111], []],
    ["a port on 0.0.0.0 and 127.0.0.1 both", [socket("0100007F", 8111), socket("00000000", 8111)], [8111], []],
    ["Docker's own embedded DNS on 127.0.0.11, which is in every session", [socket("0B00007F", 46601)], [], []],
    ["nothing at all", [], [], []]
  ])("should report %s", (_name, sockets, open, local) => {
    // Act / Assert
    expect(listeners(sockets)).toEqual({ open, local });
  });

  it("should report the ports in ascending order, whatever order the table had them", () => {
    // Act
    const found = listeners([socket("00000000", 9200), socket("00000000", 3000), socket("0100007F", 5555), socket("0100007F", 1080)]);

    // Assert
    expect(found).toEqual({ open: [3000, 9200], local: [1080, 5555] });
  });
});

describe("createDebounce", () => {
  it("should hold a port back until it has been seen twice in a row", () => {
    // Arrange
    const settle = createDebounce();

    // Act / Assert
    expect(settle([8111])).toEqual([]);
    expect(settle([8111])).toEqual([8111]);
    expect(settle([8111])).toEqual([8111]);
  });

  it("should forget a port seen once and then gone, so a port is never acted on from one read", () => {
    // Arrange
    const settle = createDebounce();

    // Act / Assert
    expect(settle([8111])).toEqual([]);
    expect(settle([])).toEqual([]);
    expect(settle([8111])).toEqual([]);
  });

  it("should keep a settled port while a server restarts, and drop it after three misses", () => {
    // Arrange
    const settle = createDebounce();
    settle([8111]);
    settle([8111]);

    // Act / Assert
    expect(settle([])).toEqual([8111]);
    expect(settle([])).toEqual([8111]);
    expect(settle([])).toEqual([]);
  });

  it("should reset the miss count when the port comes back", () => {
    // Arrange
    const settle = createDebounce();
    settle([8111]);
    settle([8111]);
    settle([]);
    settle([]);

    // Act / Assert
    expect(settle([8111])).toEqual([8111]);
    expect(settle([])).toEqual([8111]);
    expect(settle([])).toEqual([8111]);
    expect(settle([])).toEqual([]);
  });

  it("should settle each port on its own and report them in order", () => {
    // Arrange
    const settle = createDebounce();

    // Act
    settle([9200, 3000]);
    const settled = settle([9200, 3000, 8111]);

    // Assert
    expect(settled).toEqual([3000, 9200]);
  });

  it("should honour a different number of reads", () => {
    // Arrange
    const settle = createDebounce({ appear: 1, disappear: 1 });

    // Act / Assert
    expect(settle([8111])).toEqual([8111]);
    expect(settle([])).toEqual([]);
  });
});
