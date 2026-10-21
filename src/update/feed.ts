/**
 * The shared HMCTS Azure Artifacts feed; `hai` is not published to npmjs.org. Reads are
 * anonymous — the packument and the tarballs need no credential — so this doubles as the
 * `--registry` the install is given. Only publishing needs a PAT, and that is CI's job.
 */
export const FEED_URL = "https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/";

/** The canonical npm form: the scope separator is encoded so a scoped name stays one path segment. */
export function packumentUrl(feed: string, packageName: string): string {
  const base = feed.endsWith("/") ? feed : `${feed}/`;
  return `${base}${packageName.replace("/", "%2F")}`;
}

/** The feed answers a whole packument rather than npmjs.org's `/latest` document. */
export function latestFromPackument(body: unknown): string | null {
  const latest = (body as { "dist-tags"?: { latest?: unknown } } | null)?.["dist-tags"]?.latest;
  return typeof latest === "string" && latest !== "" ? latest : null;
}
