import { describe, expect, it } from "vitest";
import { FEED_URL } from "./feed.js";
import { detectPackageManager, PACKAGE_NAME, REGISTRY_ARG } from "./package-manager.js";

const NPM_GLOBAL = `/usr/local/lib/node_modules/${PACKAGE_NAME}`;
const NVM_GLOBAL = `/home/dev/.nvm/versions/node/v22.22.2/lib/node_modules/${PACKAGE_NAME}`;
const NPM_INSTALL = ["npm", "install", "-g", PACKAGE_NAME, REGISTRY_ARG];

describe("detectPackageManager", () => {
  it("should name the package under the CFT scope, not the public one", () => {
    // Act / Assert
    expect(PACKAGE_NAME).toBe("@hmcts-cft/hai-cli");
  });

  it("should point the registry argument at the hmcts-lib feed", () => {
    // Act / Assert
    expect(REGISTRY_ARG).toBe(`--registry=${FEED_URL}`);
  });

  it.each([
    ["a global npm install", { execPath: "/usr/local/bin/node", packagePath: NPM_GLOBAL }],
    ["nvm", { execPath: "/home/dev/.nvm/versions/node/v22.22.2/bin/node", packagePath: NVM_GLOBAL }],
    ["fnm", { execPath: "/home/dev/.fnm/node-versions/v22.22.2/installation/bin/node", packagePath: NVM_GLOBAL }],
    ["an fnm multishell", { execPath: "/tmp/fnm_multishells/12345_678/bin/node", packagePath: NVM_GLOBAL }],
    ["nothing to go on", { execPath: "/usr/bin/node", packagePath: "/opt/hai" }]
  ])("should plan a global npm install given %s", (_name, input) => {
    // Act
    const plan = detectPackageManager(input);

    // Assert
    expect(plan).toMatchObject({ manager: "npm", command: NPM_INSTALL, manualCommand: null });
  });

  it("should give the install the feed as --registry, which needs no credential", () => {
    // Act
    const plan = detectPackageManager({ execPath: "/usr/local/bin/node", packagePath: NPM_GLOBAL });

    // Assert
    expect(plan.command).toContain(REGISTRY_ARG);
    expect(plan.command?.join(" ")).not.toMatch(/token|_auth|password/i);
  });

  it.each([
    ["the package path", "/usr/local/bin/node", `/home/dev/.npm/_npx/abc123/node_modules/${PACKAGE_NAME}`, undefined],
    ["the exec path", "/home/dev/.npm/_npx/abc123/bin/node", NPM_GLOBAL, undefined],
    ["npm_command", "/usr/local/bin/node", NPM_GLOBAL, "exec"]
  ])("should never update under npx, detected from %s", (_where, execPath, packagePath, npmCommand) => {
    // Act
    const plan = detectPackageManager({ execPath, packagePath, npmCommand });

    // Assert
    expect(plan).toMatchObject({ manager: "npx", command: null, manualCommand: null });
  });

  it("should print the command rather than run it when the prefix is not writable", () => {
    // Act
    const plan = detectPackageManager({ execPath: "/usr/local/bin/node", packagePath: NPM_GLOBAL, prefixWritable: false });

    // Assert
    expect(plan.command).toBeNull();
    expect(plan.manualCommand).toEqual(NPM_INSTALL);
    expect(plan.reason).toContain("not writable");
  });

  it("should never suggest sudo", () => {
    // Act
    const plan = detectPackageManager({ execPath: "/usr/local/bin/node", packagePath: NPM_GLOBAL, prefixWritable: false });

    // Assert
    expect(plan.manualCommand?.join(" ")).not.toContain("sudo");
  });
});
