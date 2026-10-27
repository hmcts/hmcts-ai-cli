import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf, type FakeSeams } from "./__fixtures__/fake-seams.js";
import { HELPER_FILE } from "./auth/gateway.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "./az/group-membership.js";
import { launchSbx } from "./sbx-launch.js";
import { packageRoot } from "./update/self-update.js";

const HOME = "/home/linus";
const WORKSPACE = "/home/linus/Work/solirius/hmcts";
const NAME = "hai-hmcts-7293fcec";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const MANIFEST = "repos:\n  apps/pcs/pcs-api:\n    url: hmcts/pcs-api\n";

/** A published version, so the update check is not skipped as an unpublished local build. */
const PUBLISHED = { [`${packageRoot()}package.json`]: JSON.stringify({ version: "0.1.0" }) };

const VERSION_JSON = JSON.stringify({ client: { version: "v0.3.0" }, server: { version: "v0.3.0", state: "running" } });

function respond(argv: string[]) {
  if (argv[0] === "git") {
    return argv[1] === "rev-parse" ? { code: 0, stdout: `${WORKSPACE}\n` } : { code: 0, stdout: "dev\n" };
  }
  if (argv[0] === "sbx") {
    if (argv[1] === "version") {
      return { code: 0, stdout: VERSION_JSON };
    }
    if (argv[1] === "ls") {
      return { code: 0, stdout: `NAME  STATE\n${NAME}  running\n` };
    }
  }
  return { code: 0 };
}

/** A bare host: no container signals, which is the only place sbx works. */
function seamsIn(env: Record<string, string> = {}, files: Record<string, string> = {}) {
  return createFakeSeams({
    env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY, ...env },
    cwd: WORKSPACE,
    files: { [`${WORKSPACE}/workspace.yaml`]: MANIFEST, ...files },
    respond
  });
}

const sbxArgv = (seams: FakeSeams) => seams.runner.interactiveCalls[0]?.argv ?? [];

describe("launchSbx", () => {
  it("should forward every argument to the sandbox verbatim, building no claude argv of its own", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    const err = await launchSbx({ seams, processArgv: ["node", "sbx-hai", "-c", "--settings", '{"cleanupPeriodDays":42}'] }).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(0);
    expect(sbxArgv(seams)).toEqual(["sbx", "run", "--name", NAME, "--", "-c", "--settings", '{"cleanupPeriodDays":42}']);
    expect(sbxArgv(seams)).not.toContain("--dangerously-skip-permissions");
  });

  it("should run the sandbox from the workspace root when there is one", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch(() => undefined);

    // Assert
    expect(seams.runner.calls.some((call) => call.argv.join(" ") === `git -C ${WORKSPACE} config --get user.name`)).toBe(true);
  });

  it.each<[string, Record<string, string>, string]>([
    ["a docker container", { "/.dockerenv": "" }, "/.dockerenv exists"],
    ["a sandbox already", { "/etc/cft-sandbox-env.sh": "" }, "IS_SANDBOX=1"]
  ])("should refuse to run inside %s, naming the signal", async (_name, files, reason) => {
    // Arrange
    const seams = seamsIn({}, files);

    // Act
    const err = await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch((e: Error) => e);

    // Assert
    expect((err as Error).message).toContain("sbx-hai runs on the host, not inside a container");
    expect((err as Error).message).toContain(reason);
    expect(seams.runner.interactiveCalls).toEqual([]);
  });

  it("should take HAI_FORCE_HOST=1 as the way to exercise it from a devcontainer", async () => {
    // Arrange
    const seams = seamsIn({ HAI_FORCE_HOST: "1" }, { "/.dockerenv": "" });

    // Act
    await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch(() => undefined);

    // Assert
    expect(sbxArgv(seams).slice(0, 2)).toEqual(["sbx", "run"]);
  });

  it("should re-exec itself, not hai, after a self-update", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY },
      cwd: WORKSPACE,
      files: PUBLISHED,
      respond,
      fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }))
    });

    // Act
    await launchSbx({ seams, processArgv: ["node", "sbx-hai", "-c"] });

    // Assert
    expect(seams.runner.execCalls[0]?.argv).toEqual([seams.execPath, seams.scriptPath, "-c"]);
    expect(seams.runner.execCalls[0]?.opts.env?.HAI_UPDATED).toBe("1");
    expect(seams.runner.interactiveCalls).toEqual([]);
  });

  it("should report the route the host would use, since the sandbox signs in for itself", async () => {
    // Arrange
    const seams = seamsIn({ HAI_VERBOSE: "1" });

    // Act
    await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("route bedrock via env would apply on this host");
  });

  it("should report a group member's route without reading the Key Vault or warning about a fallback it forwards nothing of", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", HAI_VERBOSE: "1" },
      cwd: WORKSPACE,
      files: { [`${WORKSPACE}/workspace.yaml`]: MANIFEST },
      respond: (argv) => {
        if (argv[1] === "account") {
          return { code: 0, stdout: JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } }) };
        }
        if (argv[1] === "rest") {
          return { code: 0, stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) };
        }
        return respond(argv);
      }
    });

    // Act
    await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch(() => undefined);

    // Assert
    const said = seams.lines.join("");
    expect(said).toContain("route ai-gateway via gateway-apim would apply on this host");
    expect(said).not.toContain("APIM key could not be read");
    expect(seams.runner.calls.some((call) => call.argv[1] === "keyvault")).toBe(false);
    expect(seams.fs.store.has(`${HOME}/.local/state/hai/${HELPER_FILE}`)).toBe(false);
  });

  it("should start the sandbox anyway when no route resolves on this host", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_NO_UPDATE: "1", HAI_VERBOSE: "1" },
      cwd: WORKSPACE,
      respond: (argv) => {
        if (argv[1] === "account") {
          return { code: 0, stdout: JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } }) };
        }
        if (argv[1] === "rest") {
          return { code: 0, stdout: JSON.stringify({ value: [] }) };
        }
        return respond(argv);
      }
    });

    // Act
    await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("no route resolves on this host, which does not stop the sandbox");
    expect(sbxArgv(seams).slice(0, 2)).toEqual(["sbx", "run"]);
  });

  it("should print the sbx argv and start nothing under HAI_DRY_RUN=1", async () => {
    // Arrange
    const seams = seamsIn({ HAI_DRY_RUN: "1" });

    // Act
    const err = await launchSbx({ seams, processArgv: ["node", "sbx-hai"] }).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(0);
    expect(seams.out[0]).toContain("sbx run --name");
    expect(seams.runner.interactiveCalls).toEqual([]);
  });
});
