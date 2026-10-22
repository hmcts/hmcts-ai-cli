import { FEED_URL } from "./feed.js";

export const PACKAGE_NAME = "@hmcts-cft/hai-cli";

/** The feed is not the default registry, so every install has to name it. No credential is involved. */
export const REGISTRY_ARG = `--registry=${FEED_URL}`;

const NPX_MARKER = "/_npx/";

/**
 * Pure over what the process can see of its own installation. A global npm install is the
 * only way `hai` is installed — nvm and fnm only change which prefix `npm -g` writes into
 * — so the only decisions left are whether this is a throwaway npx run and whether that
 * prefix can be written to.
 */
export function detectPackageManager(input: { execPath: string; packagePath: string; npmCommand?: string; prefixWritable?: boolean }): PackageManagerPlan {
  const { execPath, packagePath } = input;

  if (packagePath.includes(NPX_MARKER) || execPath.includes(NPX_MARKER) || input.npmCommand === "exec") {
    // A one-off `npx @hmcts-cft/hai-cli` already fetched the latest; there is nothing to
    // update and nothing worth saying about it.
    return { command: null, manualCommand: null, reason: "running under npx" };
  }

  const command = ["npm", "install", "-g", PACKAGE_NAME, REGISTRY_ARG];
  const reason = "assuming a global npm install";
  if (input.prefixWritable === false) {
    // Never sudo: tell the engineer the command and carry on with the version we have.
    return { command: null, manualCommand: command, reason: `${reason}, but its install prefix is not writable` };
  }
  return { command, manualCommand: null, reason };
}

export interface PackageManagerPlan {
  /** Null when nothing should be run automatically. */
  command: string[] | null;
  /** Set when the update has to be run by hand; print it rather than attempting it. */
  manualCommand: string[] | null;
  reason: string;
}
