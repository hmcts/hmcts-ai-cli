import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import {
  CFT_PORTS,
  chooseFreePorts,
  choosePorts,
  EPHEMERAL_LOW_FALLBACK,
  expandPorts,
  LOCAL_PORT_RANGE_PATH,
  MINIMAL_PORTS,
  type PortProbe,
  parseEphemeralLow,
  portClashMessage,
  publishArg,
  readEphemeralLow,
  resolvePorts,
  selectPorts,
  skippedPortsMessage,
  splitEphemeral
} from "./ports.js";

const probes = (free: number[], taken: number[] = []): PortProbe[] => [
  ...free.map((port) => ({ port, free: true })),
  ...taken.map((port) => ({ port, free: false }))
];

describe("resolvePorts", () => {
  it.each<[string, string | undefined, string[]]>([
    ["unset, the port watcher being what publishes by default now", undefined, []],
    ["an empty string", "", []],
    ["cft", "cft", CFT_PORTS],
    ["minimal", "minimal", MINIMAL_PORTS],
    ["none", "none", []],
    ["one port", "8080", ["8080"]],
    ["a list", "3000,3001", ["3000", "3001"]],
    ["a range", "4451-4456", ["4451-4456"]],
    ["a list with spaces", " 3000 , 4451-4456 ", ["3000", "4451-4456"]]
  ])("should resolve %s", (_name, spec, expected) => {
    // Act / Assert
    expect(resolvePorts(spec)).toEqual(expected);
  });

  it("should keep the cftlib range in the default profile", () => {
    // Act / Assert
    expect(resolvePorts("cft")).toContain("4451-4456");
    expect(resolvePorts("cft")).toContain("5062");
  });

  it.each<[string, string]>([
    ["a word that is not a profile", "lots"],
    ["a port that is not a number", "80a0"],
    ["a port too long to be one", "123456"],
    ["a port above the highest there is", "70000"],
    ["port zero", "0"],
    ["a range the wrong way round in shape", "3000-"],
    ["a range the wrong way round in value", "4456-4451"],
    ["nothing but separators", ","]
  ])("should refuse %s, naming the value", (_name, spec) => {
    // Act / Assert
    expect(() => resolvePorts(spec)).toThrow(`HAI_PORTS=${spec}`);
  });
});

describe("expandPorts", () => {
  it.each<[string, string[], number[]]>([
    ["single ports", ["3000", "3001"], [3000, 3001]],
    ["a range", ["4451-4456"], [4451, 4452, 4453, 4454, 4455, 4456]],
    ["a one-port range", ["5062-5062"], [5062]],
    ["an empty profile", [], []],
    ["a port named twice", ["3000", "3000"], [3000]],
    ["a port a range also covers", ["4451", "4451-4453"], [4451, 4452, 4453]]
  ])("should expand %s", (_name, specs, expected) => {
    // Act / Assert
    expect(expandPorts(specs)).toEqual(expected);
  });

  it("should expand the default profile to every port in it", () => {
    // Act / Assert
    expect(expandPorts(CFT_PORTS)).toHaveLength(20);
  });
});

describe("selectPorts", () => {
  it.each<[string, PortProbe[], number[], number[]]>([
    ["all free", probes([3000, 3001, 9200]), [3000, 3001, 9200], []],
    ["one taken", probes([3000, 3001], [9200]), [3000, 3001], [9200]],
    ["several taken", probes([3001], [3000, 9200]), [3001], [3000, 9200]],
    ["all taken", probes([], [3000, 3001]), [], [3000, 3001]],
    ["the none profile, which probes nothing", [], [], []]
  ])("should publish only the free ports with %s", (_name, probed, publish, skipped) => {
    // Act / Assert
    expect(selectPorts(probed)).toEqual({ publish, skipped });
  });

  it("should keep the order the profile gave, so the argv does not churn", () => {
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

describe("splitEphemeral", () => {
  it.each<[string, number[], number, number[], number[]]>([
    ["the whole cft profile, which is well below the range", expandPorts(CFT_PORTS), 32768, expandPorts(CFT_PORTS), []],
    ["a Testcontainers mapping", [5062, 41235], 32768, [5062], [41235]],
    ["the bound itself, which is the kernel's", [32768], 32768, [], [32768]],
    ["the port below it", [32767], 32768, [32767], []],
    ["a host whose range starts lower", [15000, 9200], 10000, [9200], [15000]],
    ["no candidates at all", [], 32768, [], []]
  ])("should split %s", (_name, candidates, low, keep, ephemeral) => {
    // Act / Assert
    expect(splitEphemeral(candidates, low)).toEqual({ keep, ephemeral });
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

describe("portClashMessage", () => {
  const DAEMON_ERROR =
    "docker: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint hai-x (abc): Bind for 0.0.0.0:3000 failed: port is already allocated";

  it("should name the port the daemon refused and say it was free moments earlier", () => {
    // Act
    const message = portClashMessage({ stderr: DAEMON_ERROR, published: [3000, 9200] });

    // Assert
    expect(message).toContain("port 3000 was free moments earlier");
    expect(message).toContain("HAI_PORTS=none");
  });

  it("should name every published port when the daemon did not say which one", () => {
    // Act
    const message = portClashMessage({ stderr: "Bind failed: port is already allocated", published: [3000, 9200] });

    // Assert
    expect(message).toContain("one of the ports hai published (3000, 9200)");
  });

  it.each<[string, string]>([
    ["an unrelated failure", "no such image: hmctsprod.azurecr.io/cft-workspace/devcontainer:latest"],
    ["an empty stderr", ""]
  ])("should leave %s to the caller's own message", (_name, stderr) => {
    // Act / Assert
    expect(portClashMessage({ stderr, published: [3000] })).toBeNull();
  });
});

describe("chooseFreePorts", () => {
  it.each<[string, number[], number[], number[]]>([
    ["all free", [8080, 8081], [], [8080, 8081]],
    ["some taken", [8080, 8081], [8081], [8080]],
    ["all taken", [8080, 8081], [8080, 8081], []],
    ["no candidates at all", [], [8080], []]
  ])("should decide candidates from anywhere with %s", async (_name, candidates, portsInUse, expected) => {
    // Arrange
    const seams = createFakeSeams({ portsInUse });

    // Act / Assert
    expect(await chooseFreePorts(seams, candidates)).toEqual(expected);
  });

  it("should report a single candidate it skipped, the same way as a whole profile", async () => {
    // Arrange
    const seams = createFakeSeams({ portsInUse: [8080] });

    // Act
    await chooseFreePorts(seams, [8080]);

    // Assert
    expect(seams.lines.join("")).toContain("not publishing 8080");
  });
});

describe("choosePorts", () => {
  it("should probe every port in the profile once and publish the free ones", async () => {
    // Arrange
    const seams = createFakeSeams({ portsInUse: [9200] });

    // Act
    const published = await choosePorts(seams, "cft");

    // Assert
    expect(published).toHaveLength(19);
    expect(published).not.toContain(9200);
    expect(seams.lines.join("")).toContain("not publishing 9200");
  });

  it("should say nothing when every port is free", async () => {
    // Arrange
    const seams = createFakeSeams();

    // Act
    const published = await choosePorts(seams, "minimal");

    // Assert
    expect(published).toEqual([3000, 3001]);
    expect(seams.lines).toEqual([]);
  });

  it("should probe nothing and publish nothing for the none profile", async () => {
    // Arrange
    const probed: number[] = [];
    const seams = createFakeSeams({
      net: {
        fetch: async () => new Response(""),
        isPortFree: async (port) => {
          probed.push(port);
          return true;
        }
      }
    });

    // Act
    const published = await choosePorts(seams, "none");

    // Assert
    expect(published).toEqual([]);
    expect(probed).toEqual([]);
    expect(seams.lines).toEqual([]);
  });

  it("should skip what is taken from an explicit list too", async () => {
    // Arrange
    const seams = createFakeSeams({ portsInUse: [4453] });

    // Act
    const published = await choosePorts(seams, "3000,4451-4456");

    // Assert
    expect(published).toEqual([3000, 4451, 4452, 4454, 4455, 4456]);
    expect(seams.lines.join("")).toContain("not publishing 4453");
  });

  it("should leave an explicit port in the host's ephemeral range unpublished, and say why", async () => {
    // Arrange
    const seams = createFakeSeams({ files: { [LOCAL_PORT_RANGE_PATH]: "32768\t60999\n" } });

    // Act
    const published = await choosePorts(seams, "3000,40000");

    // Assert
    expect(published).toEqual([3000]);
    expect(seams.lines.join("")).toContain("not publishing 40000: at or above 32768");
  });

  it("should fail on a mistyped profile before probing anything", async () => {
    // Arrange
    const seams = createFakeSeams();

    // Act / Assert
    await expect(choosePorts(seams, "nonsense")).rejects.toThrow("HAI_PORTS=nonsense");
  });

  it("should count what it published under HAI_VERBOSE", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, portsInUse: [3001] });

    // Act
    await choosePorts(seams, "minimal");

    // Assert
    expect(seams.lines.join("")).toContain("publishing 1 of 2 port(s)");
  });
});
