import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import {
  chooseFreePorts,
  EPHEMERAL_LOW_FALLBACK,
  ephemeralPortsMessage,
  LOCAL_PORT_RANGE_PATH,
  type PortProbe,
  parseEphemeralLow,
  publishArg,
  readEphemeralLow,
  selectPorts,
  skippedPortsMessage
} from "./ports.js";

const probes = (free: number[], taken: number[] = []): PortProbe[] => [
  ...free.map((port) => ({ port, free: true })),
  ...taken.map((port) => ({ port, free: false }))
];

describe("selectPorts", () => {
  it.each<[string, PortProbe[], number[], number[]]>([
    ["all free", probes([3000, 3001, 9200]), [3000, 3001, 9200], []],
    ["one taken", probes([3000, 3001], [9200]), [3000, 3001], [9200]],
    ["several taken", probes([3001], [3000, 9200]), [3001], [3000, 9200]],
    ["all taken", probes([], [3000, 3001]), [], [3000, 3001]],
    ["nothing listening yet, so nothing probed", [], [], []]
  ])("should publish only the free ports with %s", (_name, probed, publish, skipped) => {
    // Act / Assert
    expect(selectPorts(probed)).toEqual({ publish, skipped });
  });

  it("should keep the order it was given, so the argv does not churn", () => {
    // Act
    const { publish } = selectPorts([
      { port: 9200, free: true },
      { port: 3000, free: false },
      { port: 3001, free: true }
    ]);

    // Assert
    expect(publish).toEqual([9200, 3001]);
  });
});

describe("publishArg", () => {
  it.each<[string, number, boolean, string]>([
    ["loopback by default, which is the URL hai reports", 5062, false, "127.0.0.1:5062:5062"],
    ["0.0.0.0 when HAI_PORTS_PUBLIC asked for it", 5062, true, "5062:5062"]
  ])("should bind %s", (_name, port, isPublic, expected) => {
    // Act / Assert
    expect(publishArg(port, isPublic)).toBe(expected);
  });
});

describe("parseEphemeralLow", () => {
  it.each<[string, string | null, number]>([
    ["this host's range", "32768\t60999\n", 32768],
    ["a range a sysctl lowered", "10000 65535\n", 10000],
    ["a single number, however unlikely", "32768", 32768],
    ["no such file, as on macOS", null, EPHEMERAL_LOW_FALLBACK],
    ["an empty file", "", EPHEMERAL_LOW_FALLBACK],
    ["something that is not a number", "lots of ports\n", EPHEMERAL_LOW_FALLBACK],
    ["a nonsense zero", "0 65535\n", EPHEMERAL_LOW_FALLBACK]
  ])("should read %s", (_name, text, expected) => {
    // Act / Assert
    expect(parseEphemeralLow(text)).toBe(expected);
  });
});

describe("readEphemeralLow", () => {
  it("should read the host's range from behind the Fs seam", async () => {
    // Arrange
    const seams = createFakeSeams({ files: { [LOCAL_PORT_RANGE_PATH]: "32768\t60999\n" } });

    // Act / Assert
    expect(await readEphemeralLow(seams)).toBe(32768);
  });

  it("should fall back on a platform that has no such file", async () => {
    // Arrange
    const seams = createFakeSeams();

    // Act / Assert
    expect(await readEphemeralLow(seams)).toBe(EPHEMERAL_LOW_FALLBACK);
  });
});

describe("ephemeralPortsMessage", () => {
  it("should name the ports and the bound that excluded them", () => {
    // Act
    const message = ephemeralPortsMessage([41235, 41236], 32768);

    // Assert
    expect(message).toContain("not publishing 41235, 41236: at or above 32768");
    expect(message).not.toContain("\n");
  });
});

describe("skippedPortsMessage", () => {
  it.each<[string, number[], string]>([
    ["one port", [9200], "not publishing 9200:"],
    ["several", [3000, 9200], "not publishing 3000, 9200:"]
  ])("should name %s in a single line", (_name, skipped, expected) => {
    // Act
    const message = skippedPortsMessage(skipped);

    // Assert
    expect(message).toContain(expected);
    expect(message).not.toContain("\n");
  });

  it("should say why a clash is skipped rather than moved", () => {
    // Act / Assert
    expect(skippedPortsMessage([3000])).toContain("OAuth redirect");
  });
});

describe("chooseFreePorts", () => {
  it.each<[string, number[], number[], number[]]>([
    ["all free", [8080, 8081], [], [8080, 8081]],
    ["some taken", [8080, 8081], [8081], [8080]],
    ["all taken", [8080, 8081], [8080, 8081], []],
    ["no candidates at all", [], [8080], []]
  ])("should decide candidates with %s", async (_name, candidates, portsInUse, expected) => {
    // Arrange
    const seams = createFakeSeams({ portsInUse });

    // Act / Assert
    expect(await chooseFreePorts(seams, candidates)).toEqual(expected);
  });

  it("should report the candidate it skipped", async () => {
    // Arrange
    const seams = createFakeSeams({ portsInUse: [8080] });

    // Act
    await chooseFreePorts(seams, [8080]);

    // Assert
    expect(seams.lines.join("")).toContain("not publishing 8080");
  });

  it("should count what it published under HAI_VERBOSE", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, portsInUse: [3001] });

    // Act
    await chooseFreePorts(seams, [3000, 3001]);

    // Assert
    expect(seams.lines.join("")).toContain("publishing 1 of 2 port(s)");
  });
});
