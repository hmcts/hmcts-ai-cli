import { describe, expect, it } from "vitest";
import { createFakeHiddenInput, createFakeSeams, exitCodeOf, type FakeSeams } from "./__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "./az/group-membership.js";
import { launch } from "./launch.js";
import { packageRoot } from "./update/self-update.js";

const HOME = "/home/dev";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const MANIFEST = "repos:\n  apps/pcs/pcs-api:\n    url: hmcts/pcs-api\n";
const MARKETPLACE = JSON.stringify({ plugins: [{ name: "pcs", source: "./apps/pcs/.claude" }] });

const IN_CONTAINER = { "/.dockerenv": "" };
/** A published version, so the update check is not skipped as an unpublished local build. */
const PUBLISHED = { [`${packageRoot()}package.json`]: JSON.stringify({ version: "0.1.0" }) };

function respond(argv: string[]) {
  if (argv[1] === "account") {
    return { stdout: JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } }) };
  }
  if (argv[1] === "rest") {
    return { stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) };
  }
  if (argv[1] === "keyvault") {
    return { stdout: `${APIM_KEY}\n` };
  }
  if (argv[0] === "getent") {
    return { code: 0 };
  }
  return { code: 0 };
}

function seamsIn(env: Record<string, string> = {}, files: Record<string, string> = {}) {
  return createFakeSeams({
    env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY, ...env },
    files: { ...IN_CONTAINER, ...files },
    respond
  });
}

const execArgv = (seams: FakeSeams) => seams.runner.execCalls[0]?.argv ?? [];
const execEnv = (seams: FakeSeams) => seams.runner.execCalls[0]?.opts.env ?? {};

describe("launch", () => {
  describe("container mode", () => {
    it("should refuse to run on a bare host, saying container mode is not built yet", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1" } });

      // Act / Assert
      await expect(launch({ seams, processArgv: ["node", "hai"] })).rejects.toThrow("container mode is not implemented yet");
    });

    it("should say what it found under verbosity", async () => {
      // Arrange
      const seams = seamsIn({ HAI_VERBOSE: "1" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(seams.lines.join("")).toContain("already containerised: /.dockerenv exists");
    });

    it("should report finding nothing under verbosity on a bare host", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1", HAI_VERBOSE: "1" } });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("no container signals");
    });

    it("should accept HAI_FORCE_CONTAINER on a host with no signals", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1", HAI_FORCE_CONTAINER: "1", AWS_BEARER_TOKEN_BEDROCK: KEY }, respond });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execArgv(seams)[0]).toBe("claude");
    });
  });

  describe("argument forwarding", () => {
    it.each<[string, string[]]>([
      ["nothing", []],
      ["-c", ["-c"]],
      ["-p with a prompt", ["-p", "x"]],
      ["doctor", ["doctor"]],
      ["mcp list", ["mcp", "list"]],
      ["--help", ["--help"]]
    ])("should forward %s to claude unchanged", async (_name, userArgs) => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai", ...userArgs] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", ...userArgs]);
    });

    it("should never put a secret on the command line", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai", "-c"] });

      // Assert
      expect(execArgv(seams).join(" ")).not.toContain(KEY);
    });

    it("should never put the gateway APIM key on the command line", async () => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "gateway", AWS_BEARER_TOKEN_BEDROCK: "" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execArgv(seams).join(" ")).not.toContain(APIM_KEY);
    });
  });

  describe("the workspace", () => {
    it("should build run.sh's argv inside a cft-workspace", async () => {
      // Arrange
      const seams = seamsIn(
        { AGENT_HUB_PLUGINS: "pcs" },
        {
          "/work/workspace.yaml": MANIFEST,
          "/work/.claude-plugin/marketplace.json": MARKETPLACE,
          "/work/apps/pcs/.claude/.claude-plugin/plugin.json": "{}"
        }
      );

      // Act
      await launch({ seams, processArgv: ["node", "hai", "-c"] });

      // Assert
      expect(execArgv(seams)).toEqual([
        "claude",
        "--settings",
        '{"crossSessionInbound":"accept"}',
        "--dangerously-skip-permissions",
        "--plugin-dir",
        "/work/apps/pcs/.claude",
        "-c"
      ]);
    });

    it("should add none of its own flags outside a workspace", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude"]);
    });

    it("should drop --dangerously-skip-permissions under HAI_PERMISSIONS=ask", async () => {
      // Arrange
      const seams = seamsIn({ HAI_PERMISSIONS: "ask" }, { "/work/workspace.yaml": MANIFEST });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execArgv(seams)).not.toContain("--dangerously-skip-permissions");
      expect(execArgv(seams)).toContain("--settings");
    });
  });

  describe("a user-supplied --settings", () => {
    it("should merge it into the one --settings claude is given", async () => {
      // Arrange
      const seams = seamsIn({}, { "/work/workspace.yaml": MANIFEST });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings", '{"cleanupPeriodDays":42}', "-c"] });

      // Assert
      expect(execArgv(seams)).toEqual([
        "claude",
        "--settings",
        '{"crossSessionInbound":"accept","cleanupPeriodDays":42}',
        "--dangerously-skip-permissions",
        "-c"
      ]);
    });

    it("should read a path through the Fs seam, relative to the cwd", async () => {
      // Arrange
      const seams = seamsIn({}, { "/work/mine.json": '{"cleanupPeriodDays":42}' });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings=mine.json"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", '{"cleanupPeriodDays":42}']);
    });

    it.each<[string, string[]]>([
      ["inline json", ["--settings", "{}"]],
      ["a path", ["--settings", "mine.json"]],
      ["the --settings= form", ["--settings={}"]],
      ["the flag twice", ["--settings", "mine.json", "--settings", "{}"]]
    ])("should never let claude see two --settings, given %s", async (_name, userArgs) => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "gateway", AWS_BEARER_TOKEN_BEDROCK: "" }, { "/work/mine.json": "{}", "/work/workspace.yaml": MANIFEST });

      // Act
      await launch({ seams, processArgv: ["node", "hai", ...userArgs] });

      // Assert
      expect(execArgv(seams).filter((arg) => arg === "--settings")).toHaveLength(1);
    });

    it("should let the user's apiKeyHelper win but warn that the token stops being refreshed", async () => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "gateway", AWS_BEARER_TOKEN_BEDROCK: "" });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings", '{"apiKeyHelper":"/tmp/mine.sh"}'] });

      // Assert
      const settingsPath = `${HOME}/.local/state/hai/settings.json`;
      expect(execArgv(seams)).toEqual(["claude", "--settings", settingsPath]);
      expect(seams.fs.store.get(settingsPath)).toBe('{"apiKeyHelper":"/tmp/mine.sh"}\n');
      expect(seams.lines.join("")).toContain("will stop being refreshed");
    });

    it("should fail naming the value when the file is not there", async () => {
      // Arrange
      const seams = seamsIn();

      // Act / Assert
      await expect(launch({ seams, processArgv: ["node", "hai", "--settings", "missing.json"] })).rejects.toThrow(
        "--settings missing.json cannot be read (looked for /work/missing.json)"
      );
    });

    it("should still re-exec with the argv as typed after an update", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY },
        files: { ...IN_CONTAINER, ...PUBLISHED },
        respond,
        fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }))
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings", "mine.json"] });

      // Assert
      expect(execArgv(seams)).toEqual([seams.execPath, seams.scriptPath, "--settings", "mine.json"]);
    });
  });

  describe("the environment handed to claude", () => {
    it("should add the Bedrock variables and mark the environment ready", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams)).toMatchObject({
        AWS_BEARER_TOKEN_BEDROCK: KEY,
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "eu-west-2",
        HAI_IN_CONTAINER: "1",
        HAI_ENV_READY: "1"
      });
    });

    it("should point claude at a generated settings file on the gateway route", async () => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "gateway", AWS_BEARER_TOKEN_BEDROCK: "" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      const settingsPath = `${HOME}/.local/state/hai/settings.json`;
      expect(execArgv(seams)).toEqual(["claude", "--settings", settingsPath]);
      expect(seams.fs.store.get(settingsPath)).toContain(`${HOME}/.local/state/hai/gateway-token.sh`);
      expect(execEnv(seams).ANTHROPIC_CUSTOM_HEADERS).toBe(`Ocp-Apim-Subscription-Key: ${APIM_KEY}`);
    });

    it("should add no Bedrock variables on the own-licence route", async () => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "own-licence", AWS_BEARER_TOKEN_BEDROCK: "", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(execEnv(seams).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
    });

    it("should prompt for a Bedrock key when nothing has one", async () => {
      // Arrange
      const typed = "ABSKVHlwZWQtYnktaGFuZC0wMDAwMDAwMDAwMDA";
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1" },
        files: IN_CONTAINER,
        respond,
        hiddenInput: createFakeHiddenInput([typed])
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).AWS_BEARER_TOKEN_BEDROCK).toBe(typed);
    });
  });

  describe("HAI_ENV_READY", () => {
    it("should resolve nothing when our own marker and HAI_ENV_READY are both set", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_IN_CONTAINER: "1", HAI_ENV_READY: "1", HAI_VERBOSE: "1" },
        respond
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "-c"] });

      // Assert
      expect(seams.runner.calls).toHaveLength(0);
      expect(execArgv(seams)).toEqual(["claude", "-c"]);
      expect(seams.lines.join("")).toContain("the route is already resolved");
    });

    it("should still resolve a route when only the marker is set", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, HAI_NO_UPDATE: "1", HAI_IN_CONTAINER: "1", AWS_BEARER_TOKEN_BEDROCK: KEY }, respond });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).CLAUDE_CODE_USE_BEDROCK).toBe("1");
    });

    it("should still add the workspace flags, which cost nothing", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_IN_CONTAINER: "1", HAI_ENV_READY: "1" },
        files: { "/work/workspace.yaml": MANIFEST },
        cwd: "/work",
        respond
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execArgv(seams)).toContain("--dangerously-skip-permissions");
    });
  });

  describe("HAI_DRY_RUN", () => {
    it("should print the invocation and exit 0 without running claude", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      const err = await launch({ seams, processArgv: ["node", "hai", "-c"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.out[0]).toBe("claude -c\n");
      expect(seams.runner.execCalls).toHaveLength(0);
    });

    it("should redact the secrets it prints", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert
      const printed = seams.out.join("");
      expect(printed).not.toContain(KEY);
      expect(printed).toContain("AWS_BEARER_TOKEN_BEDROCK=[redacted]");
      expect(printed).toContain("AWS_REGION=eu-west-2");
    });
  });

  describe("self-update", () => {
    it("should re-exec with HAI_UPDATED=1 after a successful update", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY },
        files: { ...IN_CONTAINER, ...PUBLISHED },
        respond,
        fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }))
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "-c"] });

      // Assert
      expect(execArgv(seams)).toEqual([seams.execPath, seams.scriptPath, "-c"]);
      expect(execEnv(seams).HAI_UPDATED).toBe("1");
      expect(seams.runner.execCalls).toHaveLength(1);
    });

    it("should carry straight on when there is nothing newer", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY },
        files: { ...IN_CONTAINER, ...PUBLISHED },
        respond,
        fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "0.1.0" } }))
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(seams.lines).toEqual([]);
      expect(execArgv(seams)[0]).toBe("claude");
    });

    it("should not update from a working copy, whose version is always behind the feed", async () => {
      // Arrange — no manifest in the fake fs, so the running version reads as 0.0.0.
      const seams = createFakeSeams({
        env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY },
        files: IN_CONTAINER,
        respond,
        fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }))
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(seams.runner.calls).toEqual([]);
      expect(execArgv(seams)[0]).toBe("claude");
    });

    it("should install nothing under HAI_DRY_RUN=1, even with a newer version on the feed", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, HAI_DRY_RUN: "1", AWS_BEARER_TOKEN_BEDROCK: KEY },
        files: { ...IN_CONTAINER, ...PUBLISHED },
        respond,
        fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }))
      });

      // Act
      const err = await launch({ seams, processArgv: ["node", "hai"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.runner.calls).toEqual([]);
      expect(seams.runner.execCalls).toEqual([]);
      expect(seams.lines.join("")).not.toContain("updating");
    });
  });

  describe("call order", () => {
    it("should resolve the route before it hands over to claude", async () => {
      // Arrange
      const order: string[] = [];
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY },
        files: IN_CONTAINER,
        respond: (argv) => {
          order.push(argv.join(" "));
          return respond(argv);
        }
      });
      const exec = seams.runner.exec.bind(seams.runner);
      seams.runner.exec = async (argv, opts) => {
        order.push("exec");
        return exec(argv, opts);
      };

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert — AWS_BEARER_TOKEN_BEDROCK settles the route, so nothing is looked up at all.
      expect(order).toEqual(["exec"]);
    });

    it("should ask az who we are, then check the group, before handing over", async () => {
      // Arrange
      const order: string[] = [];
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1" },
        files: IN_CONTAINER,
        hiddenInput: createFakeHiddenInput(["ABSKVHlwZWQtYnktaGFuZC0wMDAwMDAwMDAwMDA"]),
        respond: (argv) => {
          order.push(`${argv[0]} ${argv[1] ?? ""}`.trim());
          return respond(argv);
        }
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert — one az for the identity, one for the agent-hub token, then the group check.
      // The second hub call reuses the token the first one fetched.
      expect(order).toEqual(["az account", "az account", "az rest"]);
    });
  });
});
