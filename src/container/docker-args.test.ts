import { describe, expect, it } from "vitest";
import { buildClaudeEnv } from "../auth/claude-env.js";
import { ROUTES } from "../auth/route.js";
import { splitEnv } from "./container-env.js";
import {
  buildDockerArgs,
  buildDockerConfigExecArgs,
  buildSecretExecArgs,
  buildSessionExecArgs,
  type ContainerContext,
  DEFAULT_IMAGE,
  SECRETS_DIR
} from "./docker-args.js";
import { defaultSpec, resolveMounts } from "./mounts.js";
import { expandPorts, resolvePorts } from "./ports.js";
import { dockerVolumeName, NETWORK_NAME, sessionName } from "./session.js";

const HOME = "/home/linus";
const REPO = "/home/linus/Work/solirius/hmcts";
const SESSION = sessionName({ repoPath: REPO });

const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const OAUTH_TOKEN = "sk-ant-oat01-fake-own-licence-token";

function context(overrides: Partial<ContainerContext> = {}): ContainerContext {
  const spec = defaultSpec({ env: { HOME }, workspaceFolder: REPO });
  return {
    image: DEFAULT_IMAGE,
    sessionName: SESSION,
    network: NETWORK_NAME,
    platform: "linux",
    repoPath: REPO,
    workdir: REPO,
    containerUser: "hmcts",
    containerHome: "/home/hmcts",
    dockerVolume: dockerVolumeName(SESSION),
    secretsDir: SECRETS_DIR,
    runtimeDir: `${HOME}/.local/state/hai/runtime`,
    dns: ["10.11.75.4", "168.63.129.16", "8.8.8.8"],
    ports: expandPorts(resolvePorts("minimal")),
    publicPorts: false,
    mounts: resolveMounts({ spec, shareCaches: false, ownHistory: false, sessionName: SESSION, containerHome: "/home/hmcts" }),
    tty: true,
    env: { HAI_ENV_READY: "1", HAI_IN_CONTAINER: "1", HAI_SECRETS_DIR: SECRETS_DIR },
    secretEnv: {},
    ...overrides
  };
}

/** The environment each route injects, with a credential in it, as launch would hand it over. */
function routeEnv(route: (typeof ROUTES)[number]): Record<string, string> {
  return buildClaudeEnv({
    env: {},
    route,
    bedrockKey: BEDROCK_KEY,
    gateway: route === "gateway" ? { apimKey: APIM_KEY, helperPath: "/home/linus/.local/state/hai/gateway-token.sh" } : undefined
  });
}

describe("buildDockerArgs", () => {
  it("should build the whole docker run argv on linux, cft ports", () => {
    // Act
    const argv = buildDockerArgs(context({ ports: expandPorts(resolvePorts("cft")) }));

    // Assert
    expect(argv.join(" ")).toMatchInlineSnapshot(
      `"docker run -d --name hai-hmcts-7293fcec --user 0:0 --privileged --init --network hai --dns 10.11.75.4 --dns 168.63.129.16 --dns 8.8.8.8 --add-host idam-simulator:127.0.0.1 --shm-size=2g --ulimit nofile=65536:65536 --cgroupns=private --tmpfs /run:exec,mode=0755 --tmpfs /run/hai-secrets:mode=0700,uid=1000,gid=1000 --mount type=volume,source=hai-hmcts-7293fcec-docker,target=/var/lib/docker --mount type=bind,source=/home/linus/Work/solirius/hmcts,target=/home/linus/Work/solirius/hmcts --mount type=bind,source=/home/linus/.claude,target=/home/hmcts/.claude --mount type=bind,source=/home/linus/.claude.json,target=/home/hmcts/.claude.json --mount type=bind,source=/home/linus/.zsh_history,target=/home/hmcts/.zsh_history --mount type=bind,source=/home/linus/.bash_history,target=/home/hmcts/.bash_history --mount type=bind,source=/home/linus/.azure,target=/home/hmcts/.azure --mount type=bind,source=/home/linus/.kube,target=/home/hmcts/.kube --mount type=bind,source=/home/linus/.config/gh,target=/home/hmcts/.config/gh --mount type=bind,source=/home/linus/.config/twg,target=/home/hmcts/.config/twg --mount type=bind,source=/home/linus/.ssh,target=/home/hmcts/.ssh,readonly --mount type=volume,source=hai-gradle,target=/home/hmcts/.gradle --mount type=volume,source=hai-m2,target=/home/hmcts/.m2 --mount type=volume,source=hai-npm,target=/home/hmcts/.npm --mount type=volume,source=hai-yarn,target=/home/hmcts/.cache/yarn --mount type=volume,source=hai-codex,target=/home/hmcts/.codex --mount type=bind,source=/home/linus/.local/state/hai/runtime,target=/opt/hai,readonly -w /home/linus/Work/solirius/hmcts -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:3100:3100 -p 127.0.0.1:3206:3206 -p 127.0.0.1:3209:3209 -p 127.0.0.1:3453:3453 -p 127.0.0.1:3460:3460 -p 127.0.0.1:4096:4096 -p 127.0.0.1:4451:4451 -p 127.0.0.1:4452:4452 -p 127.0.0.1:4453:4453 -p 127.0.0.1:4454:4454 -p 127.0.0.1:4455:4455 -p 127.0.0.1:4456:4456 -p 127.0.0.1:5062:5062 -p 127.0.0.1:5555:5555 -p 127.0.0.1:6432:6432 -p 127.0.0.1:8087:8087 -p 127.0.0.1:8489:8489 -p 127.0.0.1:9200:9200 --env HAI_ENV_READY=1 --env HAI_IN_CONTAINER=1 --env HAI_SECRETS_DIR=/run/hai-secrets hmctsprod.azurecr.io/cft-workspace/devcontainer:latest bash /opt/hai/supervisor.sh"`
    );
  });

  it("should pass no --dns on macOS, where Docker Desktop's resolver proxies the host", () => {
    // Act
    const argv = buildDockerArgs(context({ platform: "darwin", dns: [] }));

    // Assert
    expect(argv).not.toContain("--dns");
  });

  it.each<[string, string]>([
    ["cft", "cft"],
    ["minimal", "minimal"],
    ["none", "none"]
  ])("should publish the %s port profile", (_name, profile) => {
    // Act
    const argv = buildDockerArgs(context({ ports: expandPorts(resolvePorts(profile)) }));

    // Assert
    expect(argv.filter((arg) => arg === "-p")).toHaveLength(expandPorts(resolvePorts(profile)).length);
  });

  it("should publish only the ports it was given, so a clash costs one mapping", () => {
    // Act
    const argv = buildDockerArgs(context({ ports: [3000, 3001] })).join(" ");

    // Assert
    expect(argv).toContain("-p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001");
    expect(argv).not.toContain("9200");
  });

  it("should bind every mapping to loopback, which is the URL hai reports", () => {
    // Act
    const argv = buildDockerArgs(context({ ports: [5062] })).join(" ");

    // Assert
    expect(argv).toContain("-p 127.0.0.1:5062:5062");
    expect(argv).not.toContain("-p 5062:5062");
  });

  it("should bind to 0.0.0.0 with HAI_PORTS_PUBLIC, for a session reached from another device", () => {
    // Act
    const argv = buildDockerArgs(context({ ports: [5062], publicPorts: true })).join(" ");

    // Assert
    expect(argv).toContain("-p 5062:5062");
    expect(argv).not.toContain("-p 127.0.0.1");
  });

  it("should never give the container host networking, whatever else is asked for", () => {
    // Act
    const argv = buildDockerArgs(context());

    // Assert
    expect(argv).not.toContain("--network=host");
    expect(argv.join(" ")).toContain("--network hai");
  });

  it("should never mount the host's Docker socket", () => {
    // Act / Assert
    expect(buildDockerArgs(context()).join(" ")).not.toContain("docker.sock");
  });

  it("should bind the repo at its own host path and start there", () => {
    // Act
    const argv = buildDockerArgs(context());

    // Assert
    expect(argv.join(" ")).toContain(`type=bind,source=${REPO},target=${REPO}`);
    expect(argv[argv.indexOf("-w") + 1]).toBe(REPO);
  });

  it("should start in the cwd when hai was run from a subdirectory of the repo", () => {
    // Act
    const argv = buildDockerArgs(context({ workdir: `${REPO}/apps/pcs/pcs-api` }));

    // Assert
    expect(argv[argv.indexOf("-w") + 1]).toBe(`${REPO}/apps/pcs/pcs-api`);
    expect(argv.join(" ")).toContain(`type=bind,source=${REPO},target=${REPO}`);
  });

  it("should give the nested engine its own named volume, not the host's /var/lib/docker", () => {
    // Act / Assert
    expect(buildDockerArgs(context()).join(" ")).toContain(`type=volume,source=${SESSION}-docker,target=/var/lib/docker`);
  });

  it("should sort the environment, so the argv does not churn between runs", () => {
    // Act
    const argv = buildDockerArgs(context({ env: { Z: "1", A: "2", M: "3" } }));

    // Assert
    expect(argv.filter((arg) => /^[AMZ]=/.test(arg))).toEqual(["A=2", "M=3", "Z=1"]);
  });
});

describe("the container config", () => {
  it.each(ROUTES)("should hold no credential value on the %s route", (route) => {
    // Arrange
    const { open, secret } = splitEnv(routeEnv(route));
    const ctx = context({ env: { ...open, HAI_IN_CONTAINER: "1" }, secretEnv: secret });

    // Act
    const printed = [...buildDockerArgs(ctx), ...buildSessionExecArgs(ctx, ["claude"])].join(" ");

    // Assert — the values, not just the names: a name in --env with the value elsewhere is fine.
    for (const value of Object.values(ctx.secretEnv)) {
      expect(printed).not.toContain(value);
    }
    for (const value of [BEDROCK_KEY, APIM_KEY, OAUTH_TOKEN]) {
      expect(printed).not.toContain(value);
    }
  });

  it.each(ROUTES)("should still carry the %s route's open settings, so the route works", (route) => {
    // Arrange
    const { open, secret } = splitEnv(routeEnv(route));

    // Act
    const argv = buildDockerArgs(context({ env: open, secretEnv: secret })).join(" ");

    // Assert
    for (const [name, value] of Object.entries(open)) {
      expect(argv).toContain(`--env ${name}=${value}`);
    }
  });

  it("should leave a secret that is only in the ctx out of the argv entirely", () => {
    // Act
    const argv = buildDockerArgs(context({ secretEnv: { AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY } })).join(" ");

    // Assert
    expect(argv).not.toContain(BEDROCK_KEY);
    expect(argv).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
  });
});

describe("buildSessionExecArgs", () => {
  it("should exec the entrypoint as the image's user with the claude argv after it", () => {
    // Act
    const argv = buildSessionExecArgs(context(), ["claude", "--settings", '{"crossSessionInbound":"accept"}', "-c"]);

    // Assert
    expect(argv).toEqual([
      "docker",
      "exec",
      "-i",
      "-t",
      "--user",
      "hmcts",
      "-w",
      REPO,
      SESSION,
      "bash",
      "/opt/hai/entrypoint.sh",
      "claude",
      "--settings",
      '{"crossSessionInbound":"accept"}',
      "-c"
    ]);
  });

  it("should leave out -t when stdin is not a terminal, which docker exec would refuse", () => {
    // Act
    const argv = buildSessionExecArgs(context({ tty: false }), ["claude"]);

    // Assert
    expect(argv).not.toContain("-t");
    expect(argv).toContain("-i");
  });
});

describe("the delivery execs", () => {
  it("should name the variable in argv and leave the value to stdin", () => {
    // Act
    const argv = buildSecretExecArgs(context(), "AWS_BEARER_TOKEN_BEDROCK");

    // Assert
    expect(argv).toEqual(["docker", "exec", "-i", "--user", "hmcts", SESSION, "bash", "/opt/hai/receive-secret.sh", "AWS_BEARER_TOKEN_BEDROCK"]);
  });

  it("should take the registry config on stdin too", () => {
    // Act / Assert
    expect(buildDockerConfigExecArgs(context())).toEqual(["docker", "exec", "-i", "--user", "hmcts", SESSION, "bash", "/opt/hai/receive-docker-config.sh"]);
  });
});
