import { describe, expect, it } from "vitest";
import { createFakeHiddenInput, createFakeSeams, exitCodeOf, type FakeSeams, packagedRuntime } from "./__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "./az/group-membership.js";
import { binPath, HAIR_BIN } from "./claude/hooks.js";
import { launch } from "./launch.js";
import { packageRoot } from "./update/self-update.js";

const HOME = "/home/dev";
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const APIM_KEY = "fake-apim-subscription-key";
const MANIFEST = "repos:\n  apps/pcs/pcs-api:\n    url: hmcts/pcs-api\n";
const MARKETPLACE = JSON.stringify({ plugins: [{ name: "pcs", source: "./apps/pcs/.claude" }] });

const IN_CONTAINER = { "/.dockerenv": "" };
/**
 * The session-registry hooks hai now adds to every conversation, written out rather than
 * rebuilt from `registrationHooks`: these strings are what `sh -c` inside the session
 * actually runs, so a change to the quoting or the command has to be seen here.
 */
const HOOK_BIN = `'/usr/local/bin/node' '${binPath(HAIR_BIN)}'`;
const HOOKS =
  `"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${HOOK_BIN} hook UserPromptSubmit"}]}],` +
  `"SessionEnd":[{"hooks":[{"type":"command","command":"${HOOK_BIN} hook SessionEnd"}]}]}`;
const LIVE_LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: Number.MAX_SAFE_INTEGER } });
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

/** Graph says no, which is the only way anyone reaches their own licence. */
const notAMember = (argv: string[]) => (argv[1] === "rest" ? { stdout: JSON.stringify({ value: [] }) } : respond(argv));

/** An az that can mint the agent-hub bearer token, which `respond`'s account answer cannot. */
const withHubToken = (argv: string[]) =>
  argv[2] === "get-access-token" ? { stdout: JSON.stringify({ accessToken: "eyJhbGciOiJSUzI1NiJ9.e30.c2ln", expires_on: 1800000000 }) } : respond(argv);

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
    /** A bare host: no container signals, so hai starts the container itself. */
    const onHost = (env: Record<string, string> = {}) =>
      createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY, ...env },
        cwd: "/work",
        files: packagedRuntime(),
        respond: (argv) => (argv[0] === "docker" && argv[1] === "inspect" ? { code: 1, stderr: "No such object" } : respond(argv))
      });

    it("should start a container on a bare host", async () => {
      // Arrange
      const seams = onHost();

      // Act
      const err = await launch({ seams, processArgv: ["node", "hai", "-c"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.runner.calls.find((call) => call.argv[1] === "run")?.argv).toContain("hmctsprod.azurecr.io/cft-workspace/devcontainer:latest");
      expect(seams.runner.interactiveCalls[0]?.argv.slice(-1)).toEqual(["-c"]);
      expect(seams.runner.execCalls).toEqual([]);
    });

    it("should resolve the route on the host and deliver its credential over a docker exec", async () => {
      // Arrange
      const seams = onHost();

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert
      expect(seams.runner.calls.find((call) => call.argv.includes("/opt/hai/receive-secret.sh"))?.opts.stdin).toBe(KEY);
      expect(seams.runner.calls.find((call) => call.argv[1] === "run")?.argv.join(" ")).not.toContain(KEY);
    });

    it("should deliver an exported CLAUDE_CODE_OAUTH_TOKEN on byol over the same exec channel", async () => {
      // Arrange — byol used to inject nothing at all, so a container session fell back to
      // the bind-mounted ~/.claude login: a different licence and a different bill.
      const token = "sk-ant-oat01-exported-by-hand";
      const seams = onHost({ HAI_ROUTE: "byol", AWS_BEARER_TOKEN_BEDROCK: "", CLAUDE_CODE_OAUTH_TOKEN: token });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert — on the stdin channel, and never in docker run's argv, which `docker
      // inspect` reads back.
      expect(seams.runner.calls.find((call) => call.argv.includes("/opt/hai/receive-secret.sh"))?.opts.stdin).toBe(token);
      expect(seams.runner.calls.find((call) => call.argv[1] === "run")?.argv.join(" ")).not.toContain(token);
    });

    it("should print the docker run argv and the exec under HAI_DRY_RUN", async () => {
      // Arrange
      const seams = onHost({ HAI_DRY_RUN: "1" });

      // Act
      const err = await launch({ seams, processArgv: ["node", "hai"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.out[0]).toContain("docker run -d --name hai-work-");
      expect(seams.out[1]).toContain("/opt/hai/entrypoint.sh claude");
      expect(seams.runner.calls.filter((call) => call.argv[1] === "run")).toEqual([]);
    });

    it("should take the container path even inside a container under HAI_FORCE_HOST", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_FORCE_HOST: "1", HAI_VERBOSE: "1", AWS_BEARER_TOKEN_BEDROCK: KEY },
        cwd: "/work",
        files: { ...IN_CONTAINER, ...packagedRuntime() },
        respond: (argv) => (argv[0] === "docker" && argv[1] === "inspect" ? { code: 1, stderr: "No such object" } : respond(argv))
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("HAI_FORCE_HOST=1, so hai starts the container itself");
      expect(seams.runner.calls.some((call) => call.argv[1] === "run")).toBe(true);
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
      const seams = onHost({ HAI_VERBOSE: "1" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("no container signals, so hai starts the container itself");
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
      expect(execArgv(seams)[0]).toBe("claude");
      expect(execArgv(seams).slice(execArgv(seams).length - userArgs.length)).toEqual(userArgs);
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
      const seams = seamsIn({ HAI_ROUTE: "ai-gateway", AWS_BEARER_TOKEN_BEDROCK: "" });

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
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{"crossSessionInbound":"accept",${HOOKS}}`, "--plugin-dir", "/work/apps/pcs/.claude", "-c"]);
    });

    it("should add nothing but the session-registry settings outside a workspace", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{${HOOKS}}`]);
    });

    it("should register no hooks for a -p run, which is a script rather than a conversation", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai", "-p", "summarise this"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "-p", "summarise this"]);
    });

    it("should never skip permissions by itself, and forward the flag when the user types it", async () => {
      // Arrange
      const seams = seamsIn({}, { "/work/workspace.yaml": MANIFEST });
      const asked = seamsIn({}, { "/work/workspace.yaml": MANIFEST });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });
      await launch({ seams: asked, processArgv: ["node", "hai", "--dangerously-skip-permissions"] });

      // Assert
      expect(execArgv(seams)).not.toContain("--dangerously-skip-permissions");
      expect(execArgv(asked).at(-1)).toBe("--dangerously-skip-permissions");
    });
  });

  describe("a user-supplied --settings", () => {
    it("should merge it into the one --settings claude is given", async () => {
      // Arrange
      const seams = seamsIn({}, { "/work/workspace.yaml": MANIFEST });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings", '{"cleanupPeriodDays":42}', "-c"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{"crossSessionInbound":"accept",${HOOKS},"cleanupPeriodDays":42}`, "-c"]);
    });

    it("should read a path through the Fs seam, relative to the cwd", async () => {
      // Arrange
      const seams = seamsIn({}, { "/work/mine.json": '{"cleanupPeriodDays":42}' });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings=mine.json"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{${HOOKS},"cleanupPeriodDays":42}`]);
    });

    it.each<[string, string[]]>([
      ["inline json", ["--settings", "{}"]],
      ["a path", ["--settings", "mine.json"]],
      ["the --settings= form", ["--settings={}"]],
      ["the flag twice", ["--settings", "mine.json", "--settings", "{}"]]
    ])("should never let claude see two --settings, given %s", async (_name, userArgs) => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "ai-gateway", AWS_BEARER_TOKEN_BEDROCK: "" }, { "/work/mine.json": "{}", "/work/workspace.yaml": MANIFEST });

      // Act
      await launch({ seams, processArgv: ["node", "hai", ...userArgs] });

      // Assert
      expect(execArgv(seams).filter((arg) => arg === "--settings")).toHaveLength(1);
    });

    it("should let the user's apiKeyHelper win but warn that the token stops being refreshed", async () => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "ai-gateway", AWS_BEARER_TOKEN_BEDROCK: "" });

      // Act
      await launch({ seams, processArgv: ["node", "hai", "--settings", '{"apiKeyHelper":"/tmp/mine.sh"}'] });

      // Assert
      const settingsPath = `${HOME}/.local/state/hai/settings.json`;
      expect(execArgv(seams)).toEqual(["claude", "--settings", settingsPath]);
      expect(seams.fs.store.get(settingsPath)).toBe(`{"apiKeyHelper":"/tmp/mine.sh",${HOOKS}}\n`);
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
    it("should add the Bedrock variables", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams)).toMatchObject({
        AWS_BEARER_TOKEN_BEDROCK: KEY,
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "eu-west-2"
      });
    });

    it("should set no HAI_ENV_READY marker, which this exec would leave in the session for good", async () => {
      // Arrange — the handover is in place, so anything set here is inherited by every
      // shell in the session and short-circuits each nested hai past the update check.
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).HAI_ENV_READY).toBeUndefined();
      expect(execEnv(seams).HAI_IN_CONTAINER).toBeUndefined();
    });

    it("should point claude at a generated settings file on the gateway route", async () => {
      // Arrange
      const seams = seamsIn({ HAI_ROUTE: "ai-gateway", AWS_BEARER_TOKEN_BEDROCK: "" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      const settingsPath = `${HOME}/.local/state/hai/settings.json`;
      expect(execArgv(seams)).toEqual(["claude", "--settings", settingsPath]);
      expect(seams.fs.store.get(settingsPath)).toContain(`${HOME}/.local/state/hai/gateway-token.sh`);
      expect(execEnv(seams).ANTHROPIC_CUSTOM_HEADERS).toBe(`Ocp-Apim-Subscription-Key: ${APIM_KEY}`);
    });

    it("should add no Bedrock variables on the byol route", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_ROUTE: "byol", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
        files: IN_CONTAINER,
        respond: notAMember
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(execEnv(seams).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
    });

    it("should inject the hub's token on the agent-hub route and nothing else", async () => {
      // Arrange — the hub answers with a stored claude credential.
      const token = "sk-ant-oat01-from-the-hub";
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_ROUTE: "agent-hub" },
        files: IN_CONTAINER,
        respond: withHubToken,
        fetch: async (url) => (String(url).endsWith("/credentials/claude") ? new Response(JSON.stringify({ value: token })) : new Response("", { status: 404 }))
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
      expect(execEnv(seams).CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    });

    it("should fail naming agent-hub when the hub holds no Claude token, rather than launch on whatever is on the machine", async () => {
      // Arrange — the hub's OWNER_READABLE has no claude kind today, so this is the shape
      // every owner gets. Failing here is the point: {} injected would have claude fall
      // back to the login in ~/.claude, which is a different licence and a different bill.
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_ROUTE: "agent-hub" },
        files: { ...IN_CONTAINER, [`${HOME}/.claude/.credentials.json`]: LIVE_LOGIN },
        respond: withHubToken
      });

      // Act
      const act = launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      await expect(act).rejects.toThrow("holds no Claude token for you");
      expect(seams.runner.execCalls).toEqual([]);
    });

    it("should clear an inherited CLAUDE_CODE_USE_BEDROCK on byol, so the line about who pays cannot be a lie", async () => {
      // Arrange — the bug: the handover is the process environment with `added` over it, so
      // a CLAUDE_CODE_USE_BEDROCK left in a shell profile survived and hai printed "paid
      // for by your own Claude licence" while running the session on Bedrock.
      const seams = createFakeSeams({
        env: {
          HOME,
          HAI_NO_UPDATE: "1",
          HAI_ROUTE: "byol",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_BEARER_TOKEN_BEDROCK: KEY,
          ANTHROPIC_API_KEY: "sk-ant-api03-stale",
          ANTHROPIC_CUSTOM_HEADERS: `Ocp-Apim-Subscription-Key: ${APIM_KEY}`
        },
        files: IN_CONTAINER,
        respond: notAMember
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(execEnv(seams).AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
      expect(execEnv(seams).ANTHROPIC_API_KEY).toBeUndefined();
      expect(execEnv(seams).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(execEnv(seams).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
    });

    it("should clear an inherited CLAUDE_CODE_OAUTH_TOKEN on bedrock, the same rule the other way round", async () => {
      // Arrange
      const seams = seamsIn({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(execEnv(seams).AWS_BEARER_TOKEN_BEDROCK).toBe(KEY);
    });

    it("should use the key agent-hub holds when the AI Gateway downgrades, rather than ask for one it already has", async () => {
      // Arrange — the two failures are independent: the hub probe in gatherSignals throws
      // (a 5xx, or its 15s timeout) and the Key Vault read then fails because the VPN is
      // down. hiddenInput has no answer queued, so any prompt throws rather than passing.
      let gets = 0;
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1" },
        files: IN_CONTAINER,
        respond: (argv) => {
          if (argv[2] === "get-access-token") {
            return { stdout: JSON.stringify({ accessToken: "eyJhbGciOiJSUzI1NiJ9.e30.c2ln", expires_on: 1800000000 }) };
          }
          if (argv[1] === "keyvault") {
            return { code: 1, stderr: "could not resolve the vault" };
          }
          return respond(argv);
        },
        fetch: async () => {
          gets += 1;
          return gets === 1 ? new Response("", { status: 503 }) : new Response(JSON.stringify({ value: KEY }));
        },
        hiddenInput: createFakeHiddenInput([])
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert — the downgrade is the unset path, so it reads the hub; pasting would both
      // waste the key the hub holds and overwrite it on the way back out.
      expect(execEnv(seams).AWS_BEARER_TOKEN_BEDROCK).toBe(KEY);
      expect(gets).toBe(2);
    });

    it("should prompt a group member for a Bedrock key rather than bill their own subscription when the gateway is unreachable", async () => {
      // Arrange — the incident: a member with a live personal login and no Bedrock key,
      // on a host where the private Key Vault cannot be reached.
      const typed = "ABSKVHlwZWQtYnktaGFuZC0wMDAwMDAwMDAwMDA";
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1" },
        files: { ...IN_CONTAINER, [`${HOME}/.claude/.credentials.json`]: LIVE_LOGIN },
        respond: (argv) => (argv[1] === "keyvault" ? { code: 1, stderr: "could not resolve the vault" } : respond(argv)),
        hiddenInput: createFakeHiddenInput([typed])
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(execEnv(seams).AWS_BEARER_TOKEN_BEDROCK).toBe(typed);
      expect(execEnv(seams).CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(seams.lines.join("")).toContain("hai will not use your personal claude.ai subscription");
    });
  });

  describe("the route line", () => {
    it.each<[string, Record<string, string>, string]>([
      ["bedrock", { AWS_BEARER_TOKEN_BEDROCK: KEY }, "HMCTS"],
      ["ai-gateway", { HAI_ROUTE: "ai-gateway", AWS_BEARER_TOKEN_BEDROCK: "" }, "HMCTS"],
      ["byol", { HAI_ROUTE: "byol", AWS_BEARER_TOKEN_BEDROCK: "", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, "not HMCTS"]
    ])("should say who pays for %s without HAI_VERBOSE", async (route, env, who) => {
      // Arrange — no HAI_VERBOSE anywhere: an explicit HAI_ROUTE is obeyed with no
      // fallbacks now, so this line is the only guard left against one left in a profile.
      const seams = seamsIn(env);

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(seams.lines.join("")).toContain(`route ${route} — paid for by`);
      expect(seams.lines.join("")).toContain(who);
    });

    it("should say it before it asks for a key, so the prompt has a reason", async () => {
      // Arrange
      const typed = "ABSKVHlwZWQtYnktaGFuZC0wMDAwMDAwMDAwMDA";
      let said = "";
      const seams = createFakeSeams({
        env: { HOME, HAI_NO_UPDATE: "1", HAI_ROUTE: "bedrock" },
        files: IN_CONTAINER,
        respond,
        hiddenInput: {
          isTty: true,
          readHidden: async () => {
            // Arrange — recorded at the moment the prompt is raised.
            said = seams.lines.join("");
            return typed;
          }
        }
      });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] });

      // Assert
      expect(said).toContain("route bedrock");
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
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{${HOOKS}}`, "-c"]);
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
      expect(execArgv(seams)).toContain("--settings");
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
      expect(seams.out[0]).toBe(`claude --settings {${HOOKS}} -c\n`);
      expect(seams.runner.execCalls).toHaveLength(0);
    });

    it("should name what it cleared as well as what it added", async () => {
      // Arrange — a stale personal token with the bedrock route, which is the shape the
      // dry run exists to let someone check.
      const seams = seamsIn({ HAI_DRY_RUN: "1", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });

      // Act
      await launch({ seams, processArgv: ["node", "hai"] }).catch(() => undefined);

      // Assert
      expect(seams.out.join("")).toContain("cleared: ");
      expect(seams.out.join("")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
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

      // Assert — the route line is the only thing an ordinary launch says.
      expect(seams.lines).toEqual([expect.stringContaining("route bedrock")]);
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

    it("should ask az who we are, then check the group, then settle the gateway, before handing over", async () => {
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

      // Assert — one az for the identity, one for the agent-hub token, then the group
      // check, which puts a member on the gateway and sends it after the APIM key. The
      // second hub call reuses the token the first one fetched.
      expect(order).toEqual(["az account", "az account", "az rest", "getent hosts", "az keyvault"]);
    });
  });
});
