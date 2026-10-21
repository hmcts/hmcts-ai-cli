import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf, type FakeSeams, packagedRuntime, type RunResponder } from "../__fixtures__/fake-seams.js";
import { DEFAULT_IMAGE } from "./docker-args.js";
import { CONCURRENT_REFUSAL } from "./lock.js";
import { runContainerMode } from "./run.js";

const HOME = "/home/linus";
const REPO = "/home/linus/Work/solirius/hmcts";
const SESSION = "hai-hmcts-7293fcec";
const LOCK = `${HOME}/.claude/projects/-home-linus-Work-solirius-hmcts/.hai.lock`;
const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const ACR_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake-acr-token.sig";

/** Every docker and git call container mode makes, answered the way a working host would. */
const respond: RunResponder = (argv) => {
  if (argv[0] === "git") {
    if (argv[2] === "--show-toplevel") {
      return { code: 0, stdout: `${REPO}\n` };
    }
    return { code: 0, stdout: argv[4] === "user.name" ? "Linus Norton\n" : "linus@example.com\n" };
  }
  if (argv[0] === "az") {
    return { code: 0, stdout: argv[1] === "acr" ? ACR_TOKEN : "" };
  }
  if (argv[0] === "docker" && argv[1] === "network" && argv[2] === "inspect") {
    return { code: 1, stderr: "Error: No such network: hai" };
  }
  if (argv[0] === "docker" && argv[1] === "inspect") {
    return { code: 1, stderr: "Error: No such object" };
  }
  if (argv[0] === "docker" && argv[1] === "run") {
    return { code: 0, stdout: "0123456789abcdef\n" };
  }
  return { code: 0 };
};

function seamsIn(env: Record<string, string> = {}, files: Record<string, string> = {}, over: Partial<Parameters<typeof createFakeSeams>[0]> = {}) {
  return createFakeSeams({
    env: { HOME, ...env },
    cwd: REPO,
    files: { ...packagedRuntime(), ...files },
    respond,
    ...over
  });
}

const input = (seams: FakeSeams, over: Partial<Parameters<typeof runContainerMode>[0]> = {}) => ({
  seams,
  forwarded: [] as string[],
  added: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-2", AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY },
  hasGateway: false,
  workspaceRoot: null as string | null,
  pluginDirs: [] as string[],
  ...over
});

const argvOf = (seams: FakeSeams, head: string[]) => seams.runner.calls.find((call) => head.every((part, index) => call.argv[index] === part))?.argv ?? [];

describe("runContainerMode", () => {
  it("should start the container, deliver the credentials and hand over the terminal", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    const err = await runContainerMode(input(seams)).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(0);
    expect(argvOf(seams, ["docker", "run"])).toContain(DEFAULT_IMAGE);
    expect(argvOf(seams, ["docker", "exec", "-i", "--user", "hmcts", SESSION, "bash", "/opt/hai/receive-secret.sh"])).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(seams.runner.interactiveCalls[0]?.argv.slice(-2)).toEqual(["/opt/hai/entrypoint.sh", "claude"]);
  });

  it("should default to the published image with no HAI_IMAGE set", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "run"])).toContain("hmctsprod.azurecr.io/cft-workspace/devcontainer:latest");
  });

  it.each<[string, string | undefined, string]>([
    ["an override", "hai-devcontainer:dind", "hai-devcontainer:dind"],
    ["an empty override, which reads as unset", "", DEFAULT_IMAGE]
  ])("should honour HAI_IMAGE given %s", async (_name, image, expected) => {
    // Arrange
    const seams = seamsIn(image === undefined ? {} : { HAI_IMAGE: image });

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "run"])).toContain(expected);
  });

  it("should deliver the credential on stdin, never in the container config", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "run"]).join(" ")).not.toContain(BEDROCK_KEY);
    const delivery = seams.runner.calls.find((call) => call.argv.includes("/opt/hai/receive-secret.sh"));
    expect(delivery?.opts.stdin).toBe(BEDROCK_KEY);
    expect(delivery?.argv.join(" ")).not.toContain(BEDROCK_KEY);
  });

  it("should give the nested engine a registry config on stdin too", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    const delivery = seams.runner.calls.find((call) => call.argv.includes("/opt/hai/receive-docker-config.sh"));
    expect(delivery?.opts.stdin).toContain("auths");
    expect(delivery?.argv.join(" ")).not.toContain(ACR_TOKEN);
  });

  it("should take the transcript lock and release it when the session ends", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.fs.store.has(LOCK)).toBe(false);
  });

  it("should refuse when another live session holds the transcripts", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      { [LOCK]: JSON.stringify({ pid: 999, container: "hai-hmcts-other111", at: 0 }) },
      {
        respond: (argv) => {
          if (argv[0] === "docker" && argv[1] === "inspect") {
            return { code: 0, stdout: "true\n" };
          }
          return argv[0] === "ps" ? { code: 0, stdout: "999\n" } : respond(argv);
        }
      }
    );

    // Act / Assert
    await expect(runContainerMode(input(seams))).rejects.toThrow(CONCURRENT_REFUSAL);
    expect(seams.runner.calls.filter((call) => call.argv[1] === "run")).toEqual([]);
  });

  it("should remove the container it started", async () => {
    // Arrange
    const seams = seamsIn({ HAI_VERBOSE: "1" });

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "rm", "-f"])).toEqual(["docker", "rm", "-f", SESSION]);
    expect(seams.lines.join("")).toContain(`removed ${SESSION}`);
  });

  it("should reattach to a container that is already up, and leave it running", async () => {
    // Arrange
    const seams = seamsIn(
      { HAI_VERBOSE: "1" },
      {},
      {
        respond: (argv) => (argv[0] === "docker" && argv[1] === "inspect" && argv.includes(SESSION) ? { code: 0, stdout: "true\n" } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.runner.calls.filter((call) => call.argv[1] === "run")).toEqual([]);
    expect(seams.runner.calls.filter((call) => call.argv[1] === "rm")).toEqual([]);
    expect(seams.lines.join("")).toContain("reattaches");
  });

  it("should replace a container that exists but has stopped", async () => {
    // Arrange
    let inspected = 0;
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => {
          if (argv[0] === "docker" && argv[1] === "inspect" && argv.includes(SESSION)) {
            inspected += 1;
            return { code: 0, stdout: "false\n" };
          }
          return respond(argv);
        }
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(inspected).toBeGreaterThan(0);
    expect(seams.runner.calls.filter((call) => call.argv[1] === "rm")).toHaveLength(2);
    expect(seams.runner.calls.filter((call) => call.argv[1] === "run")).toHaveLength(1);
  });

  it("should remove the container even when the session itself failed", async () => {
    // Arrange
    const seams = seamsIn();
    seams.runner.interactive = async () => {
      throw new Error("docker exec died");
    };

    // Act / Assert
    await expect(runContainerMode(input(seams))).rejects.toThrow("docker exec died");
    expect(argvOf(seams, ["docker", "rm", "-f"])).toContain(SESSION);
    expect(seams.fs.store.has(LOCK)).toBe(false);
  });

  it("should leave with the session's own exit status", async () => {
    // Arrange
    const seams = seamsIn();
    seams.runner.interactive = async () => 7;

    // Act
    const err = await runContainerMode(input(seams)).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(7);
  });

  it("should create the network when it is not there, and not when it is", async () => {
    // Arrange
    const made = seamsIn();
    const already = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv[0] === "docker" && argv[1] === "network" && argv[2] === "inspect" ? { code: 0 } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(made)).catch(() => undefined);
    await runContainerMode(input(already)).catch(() => undefined);

    // Assert
    expect(argvOf(made, ["docker", "network", "create"])).toEqual(["docker", "network", "create", "hai"]);
    expect(argvOf(already, ["docker", "network", "create"])).toEqual([]);
  });

  it("should fail when the network cannot be created", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv[0] === "docker" && argv[1] === "network" ? { code: 1, stderr: "permission denied" } : respond(argv))
      }
    );

    // Act / Assert
    await expect(runContainerMode(input(seams))).rejects.toThrow("could not create the hai Docker network: permission denied");
  });

  it("should fail when the container will not start", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv[0] === "docker" && argv[1] === "run" ? { code: 125, stderr: "no such image" } : respond(argv))
      }
    );

    // Act / Assert
    await expect(runContainerMode(input(seams))).rejects.toThrow("could not start the hai container: no such image");
  });

  it("should fail naming the credential when it cannot be delivered", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv.includes("/opt/hai/receive-secret.sh") ? { code: 1, stderr: "exec refused" } : respond(argv))
      }
    );

    // Act / Assert
    await expect(runContainerMode(input(seams))).rejects.toThrow("could not hand AWS_BEARER_TOKEN_BEDROCK to the container: exec refused");
  });

  it("should say so and carry on when the nested engine never answers", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv[0] === "docker" && argv.includes("version") ? { code: 1 } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("nested Docker engine did not come up");
    expect(seams.runner.interactiveCalls).toHaveLength(1);
  });

  it("should say so and carry on when the nested engine refuses the registry config", async () => {
    // Arrange
    const seams = seamsIn(
      { HAI_VERBOSE: "1" },
      {},
      {
        respond: (argv) => (argv.includes("/opt/hai/receive-docker-config.sh") ? { code: 1, stderr: "no such file" } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("could not give the nested Docker engine a pull token");
    expect(seams.runner.interactiveCalls).toHaveLength(1);
  });

  it("should say so and carry on when there is no ACR pull token for the nested engine", async () => {
    // Arrange
    const seams = seamsIn(
      { HAI_VERBOSE: "1", HAI_PULL: "never" },
      {},
      {
        respond: (argv) => (argv[0] === "az" ? { code: 1 } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("no hmctsprod pull token");
    expect(seams.runner.interactiveCalls).toHaveLength(1);
  });

  it("should prepare every host path it is about to mount", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.fs.dirs).toContain(`${HOME}/.claude`);
    expect(seams.fs.dirs).toContain(`${HOME}/.config/twg`);
    expect(seams.fs.store.get(`${HOME}/.zsh_history`)).toBe("");
    expect(JSON.parse(seams.fs.store.get(`${HOME}/.claude.json`)!).hasCompletedOnboarding).toBe(true);
  });

  it("should leave a history file that already has something in it alone", async () => {
    // Arrange
    const seams = seamsIn({}, { [`${HOME}/.zsh_history`]: "an old command\n" });

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.fs.store.get(`${HOME}/.zsh_history`)).toBe("an old command\n");
  });

  it("should forward the host's git identity, since ~/.gitconfig is not mounted", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "run"])).toContain("CFT_GIT_AUTHOR_NAME=Linus Norton");
  });

  it("should forward no git identity when the host has none", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv[0] === "git" && argv[1] === "config" ? { code: 1 } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "run"]).join(" ")).not.toContain("CFT_GIT_AUTHOR");
  });

  it("should fall back to the cwd when this is not a git repo", async () => {
    // Arrange
    const seams = seamsIn(
      {},
      {},
      {
        respond: (argv) => (argv[0] === "git" && argv[2] === "--show-toplevel" ? { code: 128, stderr: "not a git repository" } : respond(argv))
      }
    );

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(argvOf(seams, ["docker", "run"]).join(" ")).toContain(`type=bind,source=${REPO},target=${REPO}`);
  });

  it("should read the repo's own devcontainer.json when it has one", async () => {
    // Arrange
    const devcontainer = JSON.stringify({ mounts: [`source=${HOME}/.claude,target=/home/dev/.claude,type=bind`], containerUser: "dev" });
    const seams = seamsIn({ HAI_VERBOSE: "1" }, { [`${REPO}/.devcontainer/devcontainer.json`]: devcontainer });

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("mounts from the repo's .devcontainer/devcontainer.json");
    expect(argvOf(seams, ["docker", "run"]).join(" ")).toContain(`type=bind,source=${HOME}/.claude,target=/home/dev/.claude`);
    expect(seams.runner.interactiveCalls[0]?.argv).toContain("dev");
  });

  it("should fall back to the built-in list when the repo's devcontainer.json cannot be read", async () => {
    // Arrange
    const seams = seamsIn({ HAI_VERBOSE: "1" }, { [`${REPO}/.devcontainer/devcontainer.json`]: "{ broken" });

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("mounts from hai's built-in list");
  });

  it("should fail when HOME is not set, rather than mount paths under nothing", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {}, cwd: REPO, respond });

    // Act / Assert
    await expect(runContainerMode(input(seams))).rejects.toThrow("HOME is not set");
  });

  it("should warn once when no link carries the internal domains", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("no network link carries the HMCTS internal domains");
  });

  it("should say nothing about DNS on macOS, where Docker Desktop handles it", async () => {
    // Arrange
    const seams = seamsIn({}, {}, { platform: "darwin" });

    // Act
    await runContainerMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).not.toContain("internal domains");
  });

  describe("the claude argv it builds for the container", () => {
    it("should point the gateway's apiKeyHelper at the container's own state directory", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runContainerMode(input(seams, { hasGateway: true })).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv).toContain('{"apiKeyHelper":"/home/hmcts/.local/state/hai/gateway-token.sh"}');
    });

    it("should add the workspace flags when the repo is a cft-workspace", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runContainerMode(input(seams, { workspaceRoot: REPO, pluginDirs: [`${REPO}/apps/pcs/.claude`] })).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv.slice(-6)).toEqual([
        "claude",
        "--settings",
        '{"crossSessionInbound":"accept"}',
        "--dangerously-skip-permissions",
        "--plugin-dir",
        `${REPO}/apps/pcs/.claude`
      ]);
    });

    it("should forward the user's arguments and merge their --settings", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runContainerMode(input(seams, { forwarded: ["--settings", '{"cleanupPeriodDays":42}', "-c"] })).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv.slice(-4)).toEqual(["claude", "--settings", '{"cleanupPeriodDays":42}', "-c"]);
    });

    it("should warn when the user's settings replace the gateway's apiKeyHelper", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runContainerMode(input(seams, { hasGateway: true, forwarded: ["--settings", '{"apiKeyHelper":"/tmp/mine.sh"}'] })).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("will stop being refreshed");
    });
  });

  describe("HAI_DRY_RUN", () => {
    it("should print the docker run argv and the exec, and start nothing", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      const err = await runContainerMode(input(seams)).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.out[0]).toContain("docker run -d --name");
      expect(seams.out[1]).toContain("docker exec -i");
      expect(seams.runner.interactiveCalls).toEqual([]);
      expect(seams.runner.calls.filter((call) => call.argv[1] === "run")).toEqual([]);
    });

    it("should name the credentials it would deliver, with no value", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      const printed = seams.out.join("");
      expect(printed).toContain("secrets delivered on a docker exec stdin: AWS_BEARER_TOKEN_BEDROCK");
      expect(printed).toContain("AWS_BEARER_TOKEN_BEDROCK=[redacted]");
      expect(printed).not.toContain(BEDROCK_KEY);
    });

    it("should name none when the route needs none", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      await runContainerMode(input(seams, { added: {} })).catch(() => undefined);

      // Assert
      expect(seams.out.join("")).toContain("stdin: none");
    });

    it("should touch nothing on the host", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.fs.dirs.size).toBe(0);
      expect(seams.fs.store.has(LOCK)).toBe(false);
      expect(seams.fs.store.has(`${HOME}/.claude.json`)).toBe(false);
    });
  });

  describe("the ports it publishes at create time", () => {
    it("should publish nothing by default, the port watcher being what publishes now", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      const err = await runContainerMode(input(seams)).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(argvOf(seams, ["docker", "run"])).not.toContain("-p");
      expect(seams.lines.join("")).not.toContain("not publishing");
    });

    it("should start anyway when one of the cft profile's ports is taken, and say which", async () => {
      // Arrange
      const seams = seamsIn({ HAI_PORTS: "cft" }, {}, { portsInUse: [9200] });

      // Act
      const err = await runContainerMode(input(seams)).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      const argv = argvOf(seams, ["docker", "run"]).join(" ");
      expect(argv).toContain("-p 127.0.0.1:3000:3000");
      expect(argv).not.toContain("9200");
      expect(seams.lines.join("")).toContain("not publishing 9200");
    });

    it("should publish nothing and say nothing with HAI_PORTS=none", async () => {
      // Arrange
      const seams = seamsIn({ HAI_PORTS: "none" }, {}, { portsInUse: [9200] });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["docker", "run"])).not.toContain("-p");
      expect(seams.lines.join("")).not.toContain("not publishing");
    });

    it("should skip a taken port from an explicit HAI_PORTS list too", async () => {
      // Arrange
      const seams = seamsIn({ HAI_PORTS: "3000,9200" }, {}, { portsInUse: [3000] });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      const argv = argvOf(seams, ["docker", "run"]).join(" ");
      expect(argv).toContain("-p 127.0.0.1:9200:9200");
      expect(argv).not.toContain("3000");
      expect(seams.lines.join("")).toContain("not publishing 3000");
    });

    it("should probe each port of a profile once per launch, never again", async () => {
      // Arrange
      const probed: number[] = [];
      const seams = seamsIn(
        { HAI_PORTS: "cft" },
        {},
        {
          net: {
            fetch: async () => new Response(""),
            isPortFree: async (port) => {
              probed.push(port);
              return port !== 9200;
            }
          }
        }
      );

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(probed).toHaveLength(20);
      expect(new Set(probed).size).toBe(20);
    });

    it("should bind every mapping to loopback, and to 0.0.0.0 only with HAI_PORTS_PUBLIC=1", async () => {
      // Arrange
      const loopback = seamsIn({ HAI_PORTS: "minimal" });
      const open = seamsIn({ HAI_PORTS: "minimal", HAI_PORTS_PUBLIC: "1" });

      // Act
      await runContainerMode(input(loopback)).catch(() => undefined);
      await runContainerMode(input(open)).catch(() => undefined);

      // Assert
      expect(argvOf(loopback, ["docker", "run"]).join(" ")).toContain("-p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001");
      expect(argvOf(open, ["docker", "run"]).join(" ")).toContain("-p 3000:3000 -p 3001:3001");
    });

    it("should sweep a killed session's sidecars before it probes, so a port is not a clash with its own corpse", async () => {
      // Arrange: hai-...-port-5062 outlived its session and is still holding 5062
      let held = true;
      const seams = seamsIn(
        { HAI_PORTS: "cft" },
        {},
        {
          respond: (argv) => {
            if (argv[1] === "ps") {
              return { code: 0, stdout: held ? "stale5062\n" : "" };
            }
            if (argv.join(" ") === "docker rm -f stale5062") {
              held = false;
              return { code: 0 };
            }
            return respond(argv);
          },
          net: { fetch: async () => new Response(""), isPortFree: async (port) => !(held && port === 5062) }
        }
      );

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).not.toContain("not publishing");
      expect(argvOf(seams, ["docker", "run"]).join(" ")).toContain("-p 127.0.0.1:5062:5062");
    });

    it("should name the port and say it was free moments earlier when docker still clashes", async () => {
      // Arrange
      const daemon =
        "docker: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint hai (1): Bind for 0.0.0.0:3000 failed: port is already allocated";
      const seams = seamsIn(
        { HAI_PORTS: "cft" },
        {},
        { respond: (argv) => (argv[0] === "docker" && argv[1] === "run" ? { code: 125, stderr: daemon } : respond(argv)) }
      );

      // Act / Assert
      await expect(runContainerMode(input(seams))).rejects.toThrow("port 3000 was free moments earlier");
    });
  });

  describe("the ports the session starts listening on", () => {
    const WATCHED = ["docker", "exec", "--user", "hmcts", SESSION, "cat"];
    const SWEEP = ["docker", "ps", "-aq", "--filter", "label=hai.session=hai-hmcts-7293fcec"];
    const sweeps = (seams: FakeSeams) => seams.runner.calls.filter((call) => call.argv[1] === "ps").length;

    it("should watch the session for them, and stop watching when it ends", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, WATCHED)).toContain("/proc/net/tcp6");
      expect(argvOf(seams, SWEEP)).toEqual(SWEEP);
    });

    it("should sweep by label before it starts, so a killed session's sidecars cannot hold a port", async () => {
      // Arrange
      const seams = seamsIn({}, {}, { respond: (argv) => (argv[1] === "ps" ? { code: 0, stdout: "old1\n" } : respond(argv)) });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      const removed = seams.runner.calls.findIndex((call) => call.argv.join(" ") === "docker rm -f old1");
      const created = seams.runner.calls.findIndex((call) => call.argv[1] === "run");
      expect(removed).toBeGreaterThan(-1);
      expect(removed).toBeLessThan(created);
    });

    it("should sweep them again once the session has ended", async () => {
      // Arrange
      const seams = seamsIn({}, {}, { respond: (argv) => (argv[1] === "ps" ? { code: 0, stdout: "side1\n" } : respond(argv)) });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.calls.filter((call) => call.argv.join(" ") === "docker rm -f side1")).toHaveLength(2);
      expect(seams.runner.calls.findIndex((call) => call.argv.join(" ") === "docker rm -f side1")).toBeLessThan(
        seams.runner.calls.findLastIndex((call) => call.argv.join(" ") === "docker rm -f side1")
      );
    });

    it("should neither watch nor sweep a container it reattached to, the session that started it already doing both", async () => {
      // Arrange
      const seams = seamsIn(
        {},
        {},
        { respond: (argv) => (argv[0] === "docker" && argv[1] === "inspect" && argv.includes(SESSION) ? { code: 0, stdout: "true\n" } : respond(argv)) }
      );

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, WATCHED)).toEqual([]);
      expect(sweeps(seams)).toBe(0);
    });

    it("should not watch at all with HAI_NO_PORT_WATCH=1, and still sweep", async () => {
      // Arrange
      const seams = seamsIn({ HAI_NO_PORT_WATCH: "1" });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, WATCHED)).toEqual([]);
      expect(sweeps(seams)).toBe(2);
    });
  });

  describe("HAI_OWN_HISTORY", () => {
    it("should mount its own projects volume and take no lock", async () => {
      // Arrange
      const seams = seamsIn({ HAI_OWN_HISTORY: "1" }, { [LOCK]: JSON.stringify({ pid: 1, container: "other", at: 0 }) });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["docker", "run"]).join(" ")).toContain(`type=volume,source=${SESSION}-projects,target=/home/hmcts/.claude/projects`);
      expect(seams.fs.store.get(LOCK)).toContain("other");
    });
  });

  describe("HAI_SESSION", () => {
    it("should name the container what it says", async () => {
      // Arrange
      const seams = seamsIn({ HAI_SESSION: "my-session" });

      // Act
      await runContainerMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["docker", "run"])).toContain("my-session");
    });
  });
});
