import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf, type FakeSeams, type RunResponder } from "../__fixtures__/fake-seams.js";
import { KIT_IMAGE } from "./kit.js";
import { runSbxMode } from "./run.js";

const HOME = "/home/linus";
const WORKSPACE = "/home/linus/Work/solirius/hmcts";
const HISTORY = `${HOME}/.claude/projects`;
const NAME = "hai-hmcts-7293fcec";
const ACR_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake-acr-token.sig";
const DIGEST = "sha256:aaaa";

const VERSION_JSON = JSON.stringify({ client: { version: "v0.3.0" }, server: { version: "v0.3.0", state: "running" } });

/** Every sbx, az and git call this mode makes, answered the way a working host would. */
const respond: RunResponder = (argv) => {
  if (argv[0] === "git") {
    if (argv[1] === "rev-parse") {
      return { code: 0, stdout: `${WORKSPACE}\n` };
    }
    return { code: 0, stdout: argv[5] === "user.name" ? "Linus Norton\n" : "linus@example.com\n" };
  }
  if (argv[0] === "az") {
    return { code: 0, stdout: argv[1] === "acr" && argv[2] === "login" ? ACR_TOKEN : "" };
  }
  if (argv[0] === "sbx") {
    if (argv[1] === "version") {
      return { code: 0, stdout: VERSION_JSON };
    }
    if (argv[1] === "ls") {
      return { code: 0, stdout: "NAME  STATE  KIT\n" };
    }
    if (argv[1] === "settings" && argv[2] === "get") {
      return { code: 0, stdout: argv[3] === "kit.allowedSources" ? '["docker.io/"]\n' : "10g\n" };
    }
    return { code: 0 };
  }
  return { code: 0 };
};

function seamsIn(env: Record<string, string> = {}, over: Partial<Parameters<typeof createFakeSeams>[0]> = {}) {
  return createFakeSeams({ env: { HOME, ...env }, cwd: WORKSPACE, respond, ...over });
}

const input = (seams: FakeSeams, over: Partial<Parameters<typeof runSbxMode>[0]> = {}) => ({
  seams,
  forwarded: [] as string[],
  workspaceRoot: WORKSPACE as string | null,
  ...over
});

const argvOf = (seams: FakeSeams, head: string[]) => seams.runner.calls.find((call) => head.every((part, index) => call.argv[index] === part))?.argv ?? [];

/** The sandbox already exists, so the launch reattaches rather than creating a second. */
const existing: RunResponder = (argv) => (argv[0] === "sbx" && argv[1] === "ls" ? { code: 0, stdout: `NAME  STATE\n${NAME}  running\n` } : respond(argv));

describe("runSbxMode", () => {
  it("should create the sandbox from the published kit and hand over the terminal", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    const err = await runSbxMode(input(seams)).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(0);
    const argv = seams.runner.interactiveCalls[0]?.argv ?? [];
    expect(argv.slice(0, 4)).toEqual(["sbx", "run", "--name", NAME]);
    expect(argv).toContain(KIT_IMAGE);
    expect(argv.slice(-2)).toEqual([WORKSPACE, HISTORY]);
  });

  it("should leave with the session's own exit status", async () => {
    // Arrange
    const seams = seamsIn();
    seams.runner.interactive = async () => 7;

    // Act
    const err = await runSbxMode(input(seams)).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(7);
  });

  it("should forward the arguments it was given, verbatim, after a --", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runSbxMode(input(seams, { forwarded: ["-c", "--verbose"] })).catch(() => undefined);

    // Assert
    expect(seams.runner.interactiveCalls[0]?.argv.slice(-3)).toEqual(["--", "-c", "--verbose"]);
  });

  it("should reattach to a sandbox of that name rather than create a second", async () => {
    // Arrange
    const seams = seamsIn({ HAI_VERBOSE: "1" }, { respond: existing });

    // Act
    await runSbxMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.runner.interactiveCalls[0]?.argv).toEqual(["sbx", "run", "--name", NAME]);
    expect(seams.lines.join("")).toContain("reattaching to sandbox");
  });

  it("should neither touch sbx's settings nor refresh the token on a reattach", async () => {
    // Arrange
    const seams = seamsIn({}, { respond: existing });

    // Act
    await runSbxMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.runner.calls.filter((call) => call.argv[2] === "set")).toEqual([]);
    expect(seams.runner.calls.filter((call) => call.argv[0] === "az")).toEqual([]);
  });

  it("should say that the sandbox supplies its own credential", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runSbxMode(input(seams)).catch(() => undefined);

    // Assert
    expect(seams.lines.join("")).toContain("no credential and no route environment is forwarded");
  });

  it("should carry no credential of its own in the argv", async () => {
    // Arrange
    const seams = seamsIn();

    // Act
    await runSbxMode(input(seams)).catch(() => undefined);

    // Assert
    const everything = [...seams.runner.calls, ...seams.runner.interactiveCalls].map((call) => call.argv.join(" ")).join(" ");
    expect(everything).not.toContain(ACR_TOKEN);
  });

  describe("the sbx binary and its daemon", () => {
    it("should say how to install Docker Sandboxes when sbx is not there", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: (argv) => (argv[0] === "sbx" ? { code: 127, stderr: "spawn sbx ENOENT" } : respond(argv)) });

      // Act / Assert
      await expect(runSbxMode(input(seams))).rejects.toThrow("sbx is not installed");
      expect(seams.runner.interactiveCalls).toEqual([]);
    });

    it("should refuse, naming both versions, when the CLI and the daemon disagree", async () => {
      // Arrange
      const mismatch = JSON.stringify({ client: { version: "v0.3.0" }, server: { version: "v0.2.9", state: "running" } });
      const seams = seamsIn({}, { respond: (argv) => (argv[0] === "sbx" && argv[1] === "version" ? { code: 0, stdout: mismatch } : respond(argv)) });

      // Act / Assert
      await expect(runSbxMode(input(seams))).rejects.toThrow("the sbx CLI is v0.3.0 but the sandboxd it talks to is still v0.2.9");
      expect(seams.runner.interactiveCalls).toEqual([]);
    });

    it("should not attempt the restart itself, since that stops other sessions' sandboxes", async () => {
      // Arrange
      const mismatch = JSON.stringify({ client: { version: "v0.3.0" }, server: { version: "v0.2.9", state: "running" } });
      const seams = seamsIn({}, { respond: (argv) => (argv[0] === "sbx" && argv[1] === "version" ? { code: 0, stdout: mismatch } : respond(argv)) });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.calls.filter((call) => call.argv[1] === "daemon")).toEqual([]);
    });

    it("should create when sbx cannot list the sandboxes, and let sbx refuse if it must", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: (argv) => (argv[0] === "sbx" && argv[1] === "ls" ? { code: 1, stderr: "daemon not reachable" } : respond(argv)) });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv).toContain(KIT_IMAGE);
    });

    it("should carry on when the version probe cannot be read, which is sbx's own to report", async () => {
      // Arrange
      const seams = seamsIn(
        {},
        { respond: (argv) => (argv[0] === "sbx" && argv[1] === "version" ? { code: 1, stderr: "daemon not running" } : respond(argv)) }
      );

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls).toHaveLength(1);
    });
  });

  describe("the host settings a create needs", () => {
    it("should allow kits from the cft-workspace registry, keeping what is there", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["sbx", "settings", "set", "kit.allowedSources"])[4]).toBe('["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]');
      expect(seams.lines.join("")).toContain("allowed kits from");
    });

    it("should not touch the allowlist when the kit source is already on it", async () => {
      // Arrange
      const allowed = '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]';
      const seams = seamsIn(
        {},
        { respond: (argv) => (argv[1] === "settings" && argv[3] === "kit.allowedSources" ? { code: 0, stdout: allowed } : respond(argv)) }
      );

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["sbx", "settings", "set", "kit.allowedSources"])).toEqual([]);
    });

    it("should fail with the hand-written command when the allowlist cannot be set", async () => {
      // Arrange
      const seams = seamsIn(
        {},
        {
          respond: (argv) => (argv[1] === "settings" && argv[2] === "set" && argv[3] === "kit.allowedSources" ? { code: 1, stderr: "refused" } : respond(argv))
        }
      );

      // Act / Assert
      await expect(runSbxMode(input(seams))).rejects.toThrow("sbx settings set kit.allowedSources");
    });

    it("should raise the docker volume to 40g, which sbx's 10g default is overrun by", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["sbx", "settings", "set", "sandbox.disk.dockerVolume"])).toEqual(["sbx", "settings", "set", "sandbox.disk.dockerVolume", "40g"]);
      expect(seams.lines.join("")).toContain("was 10g");
    });

    it("should leave a bigger volume size someone else chose alone", async () => {
      // Arrange
      const seams = seamsIn(
        { HAI_VERBOSE: "1" },
        { respond: (argv) => (argv[1] === "settings" && argv[3] === "sandbox.disk.dockerVolume" ? { code: 0, stdout: "80g" } : respond(argv)) }
      );

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(argvOf(seams, ["sbx", "settings", "set", "sandbox.disk.dockerVolume"])).toEqual([]);
      expect(seams.lines.join("")).toContain("already 80g");
    });

    it("should say so and create anyway when the volume size cannot be raised", async () => {
      // Arrange
      const seams = seamsIn(
        {},
        { respond: (argv) => (argv[2] === "set" && argv[3] === "sandbox.disk.dockerVolume" ? { code: 1, stderr: "refused" } : respond(argv)) }
      );

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("sbx's 10g default");
      expect(seams.runner.interactiveCalls).toHaveLength(1);
    });
  });

  describe("the registry secret", () => {
    it("should store one fresh token in both scopes, on stdin", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      const stores = seams.runner.calls.filter((call) => call.argv[1] === "secret");
      expect(stores.map((call) => call.argv[3])).toEqual(["-f", "--all-sandboxes"]);
      expect(stores.map((call) => call.opts.stdin)).toEqual([ACR_TOKEN, ACR_TOKEN]);
      expect(seams.runner.calls.filter((call) => call.argv[0] === "az" && call.argv[2] === "login")).toHaveLength(1);
    });

    it("should say so and create anyway when there is no az session to mint a token with", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: (argv) => (argv[0] === "az" ? { code: 1, stderr: "please run az login" } : respond(argv)) });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("run az login");
      expect(seams.runner.calls.filter((call) => call.argv[1] === "secret")).toEqual([]);
      expect(seams.runner.interactiveCalls).toHaveLength(1);
    });

    it("should name the scope that refused and create anyway", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: (argv) => (argv.includes("--all-sandboxes") ? { code: 1, stderr: "no such scope" } : respond(argv)) });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("for the sandboxes' own Docker engine: no such scope");
      expect(seams.runner.interactiveCalls).toHaveLength(1);
    });
  });

  describe("the kit staleness check", () => {
    const stale: RunResponder = (argv) => {
      if (argv[0] === "sbx" && argv[1] === "inspect") {
        return { code: 0, stdout: JSON.stringify({ kits: [KIT_IMAGE], image_digest: DIGEST }) };
      }
      if (argv[0] === "az" && argv[2] === "repository") {
        return { code: 0, stdout: "sha256:index\n" };
      }
      if (argv[0] === "az" && argv[2] === "manifest") {
        return { code: 0, stdout: JSON.stringify({ manifests: [{ digest: "sha256:other" }] }) };
      }
      return existing(argv);
    };

    it("should warn, and reattach anyway, when a newer kit is published", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: stale });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain(`sbx rm -f ${NAME}`);
      expect(seams.runner.interactiveCalls).toHaveLength(1);
    });

    it("should call it current when the recorded digest is one arch of the published index", async () => {
      // Arrange
      const seams = seamsIn(
        {},
        {
          respond: (argv) =>
            argv[0] === "az" && argv[2] === "manifest" ? { code: 0, stdout: JSON.stringify({ manifests: [{ digest: DIGEST }] }) } : stale(argv)
        }
      );

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).not.toContain("newer kit");
    });

    it("should ask for the manifest only when the tag's digest differs", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: (argv) => (argv[0] === "az" && argv[2] === "repository" ? { code: 0, stdout: `${DIGEST}\n` } : stale(argv)) });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.calls.filter((call) => call.argv[2] === "manifest")).toEqual([]);
      expect(seams.lines.join("")).not.toContain("newer kit");
    });

    it.each<[string, RunResponder]>([
      ["sbx inspect cannot be read", (argv) => (argv[1] === "inspect" ? { code: 1, stderr: "no such sandbox" } : stale(argv))],
      ["the sandbox was built from a local kit", (argv) => (argv[1] === "inspect" ? { code: 0, stdout: JSON.stringify({ kits: ["/src/sbx"] }) } : stale(argv))],
      ["az cannot read the published digest", (argv) => (argv[0] === "az" && argv[2] === "repository" ? { code: 1 } : stale(argv))],
      ["az cannot read the manifest", (argv) => (argv[0] === "az" && argv[2] === "manifest" ? { code: 1 } : stale(argv))]
    ])("should report not stale when %s", async (_name, responder) => {
      // Arrange
      const seams = seamsIn({ HAI_VERBOSE: "1" }, { respond: responder });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).not.toContain("newer kit");
      expect(seams.runner.interactiveCalls).toHaveLength(1);
    });
  });

  describe("what it forwards into the sandbox", () => {
    it("should forward the git identity read from the checkout, not the home directory", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      const argv = seams.runner.interactiveCalls[0]?.argv ?? [];
      expect(argv).toContain("CFT_GIT_AUTHOR_NAME=Linus Norton");
      expect(argv).toContain("CFT_GIT_AUTHOR_EMAIL=linus@example.com");
      expect(seams.runner.calls.some((call) => call.argv.join(" ") === `git -C ${WORKSPACE} config --get user.name`)).toBe(true);
    });

    it.each<[string, RunResponder]>([
      ["the checkout has no identity", (argv) => (argv[0] === "git" && argv[1] === "-C" ? { code: 1 } : respond(argv))],
      ["it has a name but no email", (argv) => (argv[0] === "git" && argv[5] === "user.email" ? { code: 0, stdout: "\n" } : respond(argv))]
    ])("should forward no identity at all when %s", async (_name, responder) => {
      // Arrange
      const seams = seamsIn({}, { respond: responder });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect((seams.runner.interactiveCalls[0]?.argv ?? []).join(" ")).not.toContain("CFT_GIT_AUTHOR");
    });

    it("should share the host's conversation history and make sure it exists first", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv).toContain(`CFT_HOST_CLAUDE_PROJECTS=${HISTORY}`);
      expect(seams.fs.dirs).toContain(HISTORY);
    });

    it("should keep the history inside the sandbox with HAI_OWN_HISTORY=1", async () => {
      // Arrange
      const seams = seamsIn({ HAI_OWN_HISTORY: "1" });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      const argv = seams.runner.interactiveCalls[0]?.argv ?? [];
      expect(argv.join(" ")).not.toContain("CFT_HOST_CLAUDE_PROJECTS");
      expect(argv.slice(-1)).toEqual([WORKSPACE]);
      expect(seams.fs.dirs.size).toBe(0);
    });

    it("should mount the git toplevel when this is not a cft-workspace checkout", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await runSbxMode(input(seams, { workspaceRoot: null })).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv).toContain(WORKSPACE);
    });

    it("should fall back to the cwd when this is not a git repo either", async () => {
      // Arrange
      const seams = seamsIn({}, { respond: (argv) => (argv[1] === "rev-parse" ? { code: 128, stderr: "not a git repository" } : respond(argv)) });

      // Act
      await runSbxMode(input(seams, { workspaceRoot: null })).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv).toContain(WORKSPACE);
    });

    it("should name the sandbox what HAI_SESSION says", async () => {
      // Arrange
      const seams = seamsIn({ HAI_SESSION: "my-sandbox" });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.interactiveCalls[0]?.argv.slice(0, 4)).toEqual(["sbx", "run", "--name", "my-sandbox"]);
    });

    it("should fail when HOME is not set, rather than share a history under nothing", async () => {
      // Arrange
      const seams = createFakeSeams({ env: {}, cwd: WORKSPACE, respond });

      // Act / Assert
      await expect(runSbxMode(input(seams))).rejects.toThrow("HOME is not set");
    });
  });

  describe("HAI_DRY_RUN", () => {
    it("should print both argvs and start nothing", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      const err = await runSbxMode(input(seams)).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.out[0]).toContain(`sbx run --name ${NAME} --pull always`);
      expect(seams.out[1]).toBe(`sbx run --name ${NAME}\n`);
      expect(seams.runner.interactiveCalls).toEqual([]);
    });

    it("should not touch sbx, the host's settings or the history directory", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.runner.calls.filter((call) => call.argv[0] === "sbx")).toEqual([]);
      expect(seams.fs.dirs.size).toBe(0);
    });

    it("should say that no credential is forwarded", async () => {
      // Arrange
      const seams = seamsIn({ HAI_DRY_RUN: "1" });

      // Act
      await runSbxMode(input(seams)).catch(() => undefined);

      // Assert
      expect(seams.out.join("")).toContain("no credential and no route environment is forwarded");
    });
  });
});
