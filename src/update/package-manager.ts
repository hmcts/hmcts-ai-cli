import { FEED_URL } from "./feed.js";

export const PACKAGE_NAME = "@hmcts-cft/hai-cli";

/** The feed is not the default registry, so every install has to name it. */
export const REGISTRY_ARG = `--registry=${FEED_URL}`;

const NPX_MARKER = "/_npx/";

/** A global npm install is the only way `hai` is installed — nvm and fnm only change which prefix `npm -g` writes into. */
export function detectPackageManager(input: { execPath: string; packagePath: string; npmCommand?: string; prefixWritable?: boolean }): PackageManagerPlan {
  const { execPath, packagePath } = input;

  if (packagePath.includes(NPX_MARKER) || execPath.includes(NPX_MARKER) || input.npmCommand === "exec") {
    // A one-off `npx @hmcts-cft/hai-cli` already fetched the latest.
    return { command: null, manualCommand: null, reason: "running under npx" };
  }

  const command = ["npm", "install", "-g", PACKAGE_NAME, REGISTRY_ARG];
  const reason = "assuming a global npm install";
  if (input.prefixWritable === false) {
    // Never sudo.
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
