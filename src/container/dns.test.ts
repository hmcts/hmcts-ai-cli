import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { type DnsLink, discoverDns, NETIF_DIR, NO_INTERNAL_LINK, parseNetif, parseNmcli, parseResolvectl, selectDnsServers } from "./dns.js";

/** As `resolvectl` prints it on this host with the F5 VPN up: link 17 is the tunnel. */
const RESOLVECTL_DNS_VPN_UP = `Global:
Link 5 (docker0):
Link 4 (wlp0s20f3):
Link 3 (enp0s31f6): 8.8.8.8 8.8.4.4
Link 17 (ppp0): 10.11.75.4 168.63.129.16
`;

const RESOLVECTL_DOMAIN_VPN_UP = `Global:
Link 5 (docker0):
Link 4 (wlp0s20f3):
Link 3 (enp0s31f6): ~.
Link 17 (ppp0): ~internal ~azurewebsites.net ~hmcts.net ~platform.hmcts.net ~reform ~vault.azure.net
`;

const RESOLVECTL_DNS_VPN_DOWN = `Global:
Link 5 (docker0):
Link 3 (enp0s31f6): 8.8.8.8 8.8.4.4
`;

const RESOLVECTL_DOMAIN_VPN_DOWN = `Global:
Link 5 (docker0):
Link 3 (enp0s31f6): ~.
`;

/** Verbatim from /run/systemd/resolve/netif/17, header and all. */
const NETIF_17 = `# This is private data. Do not parse.
LLMNR=yes
MDNS=yes
SERVERS=10.11.75.4 168.63.129.16
DOMAINS=~internal ~azurewebsites.net ~hmcts.net ~platform.hmcts.net ~reform ~reform.hmcts.net ~vault.azure.net
`;

const NETIF_3 = `# This is private data. Do not parse.
LLMNR=yes
MDNS=yes
DEFAULT_ROUTE=yes
SERVERS=8.8.8.8 8.8.4.4
`;

const NETIF_5 = `# This is private data. Do not parse.
LLMNR=no
MDNS=no
DEFAULT_ROUTE=yes
`;

const VPN_LINK: DnsLink = { index: 17, name: "ppp0", servers: ["10.11.75.4", "168.63.129.16"], domains: ["~internal", "~hmcts.net"] };
const PUBLIC_LINK: DnsLink = { index: 3, name: "enp0s31f6", servers: ["8.8.8.8", "8.8.4.4"], domains: ["~."] };

describe("parseResolvectl", () => {
  it("should pair each link's servers with its routing domains", () => {
    // Act
    const links = parseResolvectl(RESOLVECTL_DNS_VPN_UP, RESOLVECTL_DOMAIN_VPN_UP);

    // Assert
    expect(links).toEqual([
      { index: 3, name: "enp0s31f6", servers: ["8.8.8.8", "8.8.4.4"], domains: ["~."] },
      { index: 4, name: "wlp0s20f3", servers: [], domains: [] },
      { index: 5, name: "docker0", servers: [], domains: [] },
      {
        index: 17,
        name: "ppp0",
        servers: ["10.11.75.4", "168.63.129.16"],
        domains: ["~internal", "~azurewebsites.net", "~hmcts.net", "~platform.hmcts.net", "~reform", "~vault.azure.net"]
      }
    ]);
  });

  it("should ignore the Global section and anything that is not a link", () => {
    // Act
    const links = parseResolvectl("Global: 1.1.1.1\nsomething else\n", "Global: ~.\n");

    // Assert
    expect(links).toEqual([]);
  });
});

describe("parseNetif", () => {
  it("should read the servers and domains out of the per-link state files", () => {
    // Act
    const links = parseNetif([
      { name: "17", content: NETIF_17 },
      { name: "3", content: NETIF_3 },
      { name: "5", content: NETIF_5 }
    ]);

    // Assert
    expect(links).toEqual([
      { index: 3, name: "link 3", servers: ["8.8.8.8", "8.8.4.4"], domains: [] },
      { index: 5, name: "link 5", servers: [], domains: [] },
      {
        index: 17,
        name: "link 17",
        servers: ["10.11.75.4", "168.63.129.16"],
        domains: ["~internal", "~azurewebsites.net", "~hmcts.net", "~platform.hmcts.net", "~reform", "~reform.hmcts.net", "~vault.azure.net"]
      }
    ]);
  });
});

describe("parseNmcli", () => {
  it("should read the two fields per device and drop the devices with neither", () => {
    // Act
    const links = parseNmcli("8.8.8.8 | 8.8.4.4\n\n10.11.75.4 | 168.63.129.16\ninternal | hmcts.net\n\n\n");

    // Assert
    expect(links).toEqual([
      { index: 0, name: "nmcli device 1", servers: ["8.8.8.8", "8.8.4.4"], domains: [] },
      { index: 1, name: "nmcli device 2", servers: ["10.11.75.4", "168.63.129.16"], domains: ["internal", "hmcts.net"] }
    ]);
  });
});

describe("selectDnsServers", () => {
  it.each<[string, DnsLink[], string, string[]]>([
    ["the VPN link's servers first, with the public one trailing", [PUBLIC_LINK, VPN_LINK], "linux", ["10.11.75.4", "168.63.129.16", "8.8.8.8"]],
    ["nothing when no link carries the internal domains", [PUBLIC_LINK], "linux", []],
    ["nothing when there are no links at all", [], "linux", []],
    ["nothing on macOS, even with a VPN link", [VPN_LINK], "darwin", []]
  ])("should pass %s", (_name, links, platform, expected) => {
    // Act
    const selection = selectDnsServers({ links, platform });

    // Assert
    expect(selection.servers).toEqual(expected);
  });

  it("should sort the internal link ahead of a public one whatever order they arrive in", () => {
    // Act
    const selection = selectDnsServers({ links: [PUBLIC_LINK, VPN_LINK], platform: "linux" });

    // Assert
    expect(selection.servers[0]).toBe("10.11.75.4");
    expect(selection.internalLinks).toEqual(["ppp0"]);
  });

  it("should match a link that carries ~hmcts.net without ~internal", () => {
    // Act
    const selection = selectDnsServers({ links: [{ ...VPN_LINK, domains: ["~hmcts.net"] }], platform: "linux" });

    // Assert
    expect(selection.servers).toContain("10.11.75.4");
  });

  it("should ignore an internal link that has no servers of its own", () => {
    // Act
    const selection = selectDnsServers({ links: [{ ...VPN_LINK, servers: [] }], platform: "linux" });

    // Assert
    expect(selection.reason).toBe(NO_INTERNAL_LINK);
  });

  it("should not repeat the public fallback when a link already names it", () => {
    // Act
    const selection = selectDnsServers({ links: [{ ...VPN_LINK, servers: ["8.8.8.8"] }], platform: "linux" });

    // Assert
    expect(selection.servers).toEqual(["8.8.8.8"]);
  });

  it("should say why on macOS rather than go looking", () => {
    // Act
    const selection = selectDnsServers({ links: [], platform: "darwin" });

    // Assert
    expect(selection.reason).toContain("Docker Desktop");
  });

  it("should take every internal link when more than one carries the domains", () => {
    // Act
    const selection = selectDnsServers({ links: [VPN_LINK, { ...VPN_LINK, index: 18, name: "ppp1", servers: ["10.0.0.1"] }], platform: "linux" });

    // Assert
    expect(selection.servers).toEqual(["10.11.75.4", "168.63.129.16", "10.0.0.1", "8.8.8.8"]);
  });
});

describe("discoverDns", () => {
  const resolvectl = (dns: string, domain: string) => (argv: string[]) => {
    if (argv[0] !== "resolvectl") {
      return undefined;
    }
    return { code: 0, stdout: argv[1] === "dns" ? dns : domain };
  };

  it("should prefer resolvectl, which is the sanctioned interface", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: resolvectl(RESOLVECTL_DNS_VPN_UP, RESOLVECTL_DOMAIN_VPN_UP) });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual(["10.11.75.4", "168.63.129.16", "8.8.8.8"]);
    expect(seams.runner.calls.map((call) => call.argv)).toEqual([
      ["resolvectl", "dns"],
      ["resolvectl", "domain"]
    ]);
  });

  it("should report no internal link with the VPN down", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: resolvectl(RESOLVECTL_DNS_VPN_DOWN, RESOLVECTL_DOMAIN_VPN_DOWN) });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual([]);
    expect(selection.reason).toBe(NO_INTERNAL_LINK);
  });

  it("should fall back to the netif state files when resolvectl is not there", async () => {
    // Arrange
    const seams = createFakeSeams({ files: { [`${NETIF_DIR}/17`]: NETIF_17, [`${NETIF_DIR}/3`]: NETIF_3 } });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual(["10.11.75.4", "168.63.129.16", "8.8.8.8"]);
  });

  it("should fall back to nmcli when neither answers", async () => {
    // Arrange
    const seams = createFakeSeams({
      respond: (argv) => (argv[0] === "nmcli" ? { code: 0, stdout: "10.11.75.4\ninternal | hmcts.net\n" } : undefined)
    });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual(["10.11.75.4", "8.8.8.8"]);
  });

  it("should end up with nothing when no source answers at all", async () => {
    // Arrange
    const seams = createFakeSeams();

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.reason).toBe(NO_INTERNAL_LINK);
  });

  it("should treat an empty resolvectl answer as no answer and try the next source", async () => {
    // Arrange
    const seams = createFakeSeams({
      files: { [`${NETIF_DIR}/17`]: NETIF_17 },
      respond: (argv) => (argv[0] === "resolvectl" ? { code: 0, stdout: "Global:\n" } : undefined)
    });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual(["10.11.75.4", "168.63.129.16", "8.8.8.8"]);
  });

  it("should treat an empty nmcli answer as no answer", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: (argv) => (argv[0] === "nmcli" ? { code: 0, stdout: "\n\n" } : undefined) });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual([]);
  });

  it("should ask nothing at all on macOS", async () => {
    // Arrange
    const seams = createFakeSeams({ platform: "darwin" });

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(seams.runner.calls).toEqual([]);
    expect(selection.servers).toEqual([]);
  });

  it("should skip a netif entry that cannot be read", async () => {
    // Arrange
    const seams = createFakeSeams({ files: { [`${NETIF_DIR}/17`]: NETIF_17 } });
    seams.fs.dirs.add(`${NETIF_DIR}/subdir`);
    seams.fs.listDir = async () => [
      { name: "17", isDirectory: false },
      { name: "gone", isDirectory: false },
      { name: "subdir", isDirectory: true }
    ];

    // Act
    const selection = await discoverDns(seams);

    // Assert
    expect(selection.servers).toEqual(["10.11.75.4", "168.63.129.16", "8.8.8.8"]);
  });
});
