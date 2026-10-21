import type { DirEntry, Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";

export const NETIF_DIR = "/run/systemd/resolve/netif";
export const PUBLIC_FALLBACK = "8.8.8.8";

/**
 * A routing-only domain (`~example.net`) is what makes a resolver authoritative for that
 * suffix and nothing else, which is exactly how the F5 client publishes the HMCTS
 * resolvers. Matching on these two is enough to pick that link out of the list.
 */
export const INTERNAL_DOMAINS = ["internal", "hmcts.net"];

export const NO_INTERNAL_LINK =
  "no network link carries the HMCTS internal domains, so AAT and other *.internal names will not resolve in the container (is the F5 VPN up?)";

/**
 * Nested Docker needs its own network namespace — a second daemon sharing the host's
 * reconfigures docker0 and flushes the host daemon's iptables chains — and a private
 * namespace cannot reach systemd-resolved's stub on the host's loopback. So the host's
 * per-link resolvers have to be found and passed explicitly.
 */
export function selectDnsServers(input: { links: DnsLink[]; platform: string }): DnsSelection {
  if (input.platform === "darwin") {
    // Docker Desktop's embedded resolver already proxies whatever the host resolves,
    // VPN links included, and overriding it loses that.
    return { servers: [], internalLinks: [], reason: "macOS: Docker Desktop's own resolver proxies the host, so no --dns is set" };
  }
  const internal = input.links.filter((link) => link.servers.length > 0 && link.domains.some(isInternalDomain));
  if (internal.length === 0) {
    // Never substitute a public resolver as the only server: that would turn every
    // internal name into a confident NXDOMAIN rather than an obvious failure.
    return { servers: [], internalLinks: [], reason: NO_INTERNAL_LINK };
  }
  // The internal resolvers answer public names too — measured — so putting them first
  // costs nothing. The public server trails only for the case where the VPN drops: an
  // unreachable server times out, and glibc does fail over on a timeout.
  const servers = unique([...internal.flatMap((link) => link.servers), PUBLIC_FALLBACK]);
  const names = internal.map((link) => link.name);
  return { servers, internalLinks: names, reason: `internal DNS from ${names.join(", ")}, with ${PUBLIC_FALLBACK} trailing as a fallback` };
}

export async function discoverDns(deps: { runner: Runner; fs: Fs; platform: string }): Promise<DnsSelection> {
  if (deps.platform === "darwin") {
    return selectDnsServers({ links: [], platform: deps.platform });
  }
  const links = (await fromResolvectl(deps)) ?? (await fromNetif(deps)) ?? (await fromNmcli(deps)) ?? [];
  return selectDnsServers({ links, platform: deps.platform });
}

/**
 * `Link 17 (ppp0): 10.11.75.4 168.63.129.16` from one call, the matching routing domains
 * from the other. The sanctioned interface, and the only one that works as the engineer
 * rather than as root.
 */
export function parseResolvectl(dnsText: string, domainText: string): DnsLink[] {
  const links = new Map<number, DnsLink>();
  for (const [text, field] of [
    [dnsText, "servers"],
    [domainText, "domains"]
  ] as const) {
    for (const line of text.split("\n")) {
      const match = /^Link\s+(\d+)\s+\(([^)]+)\):(.*)$/.exec(line.trim());
      if (match === null) {
        continue;
      }
      const index = Number(match[1]);
      const link = links.get(index) ?? { index, name: match[2]!, servers: [], domains: [] };
      link[field] = words(match[3]!);
      links.set(index, link);
    }
  }
  return [...links.values()].sort((a, b) => a.index - b.index);
}

/** `SERVERS=…` / `DOMAINS=…` from the per-link state files, whose header says not to parse them. */
export function parseNetif(files: { name: string; content: string }[]): DnsLink[] {
  return files
    .map(({ name, content }) => ({
      index: Number(name),
      name: `link ${name}`,
      servers: words(fieldValue(content, "SERVERS")),
      domains: words(fieldValue(content, "DOMAINS"))
    }))
    .sort((a, b) => a.index - b.index);
}

/**
 * `nmcli -g IP4.DNS,IP4.DOMAINS dev show` emits the two fields per device in order, with
 * the devices separated by a blank line. Last resort, for a host whose DNS is NetworkManager's
 * rather than systemd-resolved's.
 */
export function parseNmcli(text: string): DnsLink[] {
  return text
    .split(/\n\s*\n/)
    .map((block, index) => {
      // Padded, so a device that printed only one of the two fields needs no guard.
      const lines = [...block.split("\n").map((line) => line.trim()), "", ""];
      return {
        index,
        name: `nmcli device ${index + 1}`,
        servers: words(lines[0]!),
        // nmcli does not prefix a routing-only domain, so they are compared bare.
        domains: words(lines[1]!)
      };
    })
    .filter((link) => link.servers.length > 0 || link.domains.length > 0);
}

async function fromResolvectl(deps: { runner: Runner }): Promise<DnsLink[] | null> {
  const dns = await deps.runner.run(["resolvectl", "dns"], { timeoutMs: RESOLVE_TIMEOUT_MS });
  const domain = await deps.runner.run(["resolvectl", "domain"], { timeoutMs: RESOLVE_TIMEOUT_MS });
  if (dns.code !== 0 || domain.code !== 0) {
    return null;
  }
  const links = parseResolvectl(dns.stdout, domain.stdout);
  return links.length === 0 ? null : links;
}

async function fromNetif(deps: { fs: Fs }): Promise<DnsLink[] | null> {
  const entries = (await deps.fs.listDir(NETIF_DIR)).filter((entry: DirEntry) => !entry.isDirectory);
  const files: { name: string; content: string }[] = [];
  for (const entry of entries) {
    const content = await deps.fs.readText(`${NETIF_DIR}/${entry.name}`);
    if (content !== null) {
      files.push({ name: entry.name, content });
    }
  }
  return files.length === 0 ? null : parseNetif(files);
}

async function fromNmcli(deps: { runner: Runner }): Promise<DnsLink[] | null> {
  const result = await deps.runner.run(["nmcli", "-g", "IP4.DNS,IP4.DOMAINS", "dev", "show"], { timeoutMs: RESOLVE_TIMEOUT_MS });
  if (result.code !== 0) {
    return null;
  }
  const links = parseNmcli(result.stdout);
  return links.length === 0 ? null : links;
}

const RESOLVE_TIMEOUT_MS = 5000;

function isInternalDomain(domain: string): boolean {
  return INTERNAL_DOMAINS.includes(domain.replace(/^~/, ""));
}

function fieldValue(content: string, key: string): string {
  return new RegExp(`^${key}=(.*)$`, "m").exec(content)?.[1] ?? "";
}

function words(text: string): string[] {
  return text.split(/[\s,|]+/).filter((word) => word !== "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export interface DnsLink {
  index: number;
  name: string;
  servers: string[];
  domains: string[];
}

export interface DnsSelection {
  /** Empty means "pass no --dns and let Docker inherit the host's resolv.conf". */
  servers: string[];
  internalLinks: string[];
  reason: string;
}
