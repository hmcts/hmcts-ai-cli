/** Compares release versions only: a prerelease sorts below the release it precedes, and no further. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) {
    return false;
  }
  if (a.major !== b.major) {
    return a.major > b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor > b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch > b.patch;
  }
  if (a.prerelease === b.prerelease) {
    return false;
  }
  return a.prerelease === "";
}

function parse(version: string): Parsed | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(version.trim());
  if (match === null) {
    return null;
  }
  // Only the major group is mandatory; the rest default to zero, as 1.2 means 1.2.0.
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0), prerelease: match[4] ?? "" };
}

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}
