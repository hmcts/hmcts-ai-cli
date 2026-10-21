import { describe, expect, it } from "vitest";
import { TOKEN_USER } from "../container/acr.js";
import { KIT_IMAGE } from "./kit.js";
import {
  buildAllowedSourcesSetArgs,
  buildCreateArgs,
  buildDockerVolumeSetArgs,
  buildInspectArgs,
  buildKitDigestArgs,
  buildKitIndexArgs,
  buildListArgs,
  buildReattachArgs,
  buildSecretSetArgs,
  buildSettingsGetArgs,
  buildVersionArgs,
  type SbxContext,
  SECRET_SCOPES
} from "./sbx-args.js";

const HOME = "/home/linus";
const WORKSPACE = "/home/linus/Work/solirius/hmcts";
const HISTORY = `${HOME}/.claude/projects`;
const NAME = "hai-hmcts-7293fcec";

function context(overrides: Partial<SbxContext> = {}): SbxContext {
  return {
    name: NAME,
    kit: KIT_IMAGE,
    workspaces: [WORKSPACE, HISTORY],
    env: { CFT_GIT_AUTHOR_EMAIL: "linus@example.com", CFT_GIT_AUTHOR_NAME: "Linus Norton", CFT_HOST_CLAUDE_PROJECTS: HISTORY },
    claudeArgs: [],
    ...overrides
  };
}

describe("buildCreateArgs", () => {
  it("should build the whole sbx run argv", () => {
    // Act
    const argv = buildCreateArgs(context());

    // Assert
    expect(argv.join(" ")).toMatchInlineSnapshot(
      `"sbx run --name hai-hmcts-7293fcec --pull always --env CFT_GIT_AUTHOR_EMAIL=linus@example.com --env CFT_GIT_AUTHOR_NAME=Linus Norton --env CFT_HOST_CLAUDE_PROJECTS=/home/linus/.claude/projects hmctsprod.azurecr.io/cft-workspace/sbx:latest /home/linus/Work/solirius/hmcts /home/linus/.claude/projects"`
    );
  });

  it("should pull always, so a stale cached kit is never reused", () => {
    // Act / Assert
    expect(buildCreateArgs(context()).join(" ")).toContain("--pull always");
  });

  it("should mount the checkout and the shared history as workspaces, in that order", () => {
    // Act
    const argv = buildCreateArgs(context());

    // Assert
    expect(argv.slice(-2)).toEqual([WORKSPACE, HISTORY]);
  });

  it("should name only the checkout when the history stays in the sandbox", () => {
    // Act
    const argv = buildCreateArgs(context({ workspaces: [WORKSPACE], env: {} }));

    // Assert
    expect(argv.slice(-2)).toEqual([KIT_IMAGE, WORKSPACE]);
    expect(argv).not.toContain("--env");
  });

  it("should forward the claude arguments after a --, verbatim", () => {
    // Act
    const argv = buildCreateArgs(context({ claudeArgs: ["-c", "--settings", '{"cleanupPeriodDays":42}'] }));

    // Assert
    expect(argv.slice(-4)).toEqual(["--", "-c", "--settings", '{"cleanupPeriodDays":42}']);
  });

  it("should pass no -- at all when nothing was typed", () => {
    // Act / Assert
    expect(buildCreateArgs(context())).not.toContain("--");
  });

  it("should sort the environment, so the argv does not churn between runs", () => {
    // Act
    const argv = buildCreateArgs(context({ env: { Z: "1", A: "2", M: "3" } }));

    // Assert
    expect(argv.filter((arg) => /^[AMZ]=/.test(arg))).toEqual(["A=2", "M=3", "Z=1"]);
  });
});

describe("buildReattachArgs", () => {
  it("should name the sandbox and nothing else, since sbx reads the rest from its spec", () => {
    // Act / Assert
    expect(buildReattachArgs(context())).toEqual(["sbx", "run", "--name", NAME]);
  });

  it("should still forward the claude arguments", () => {
    // Act / Assert
    expect(buildReattachArgs(context({ claudeArgs: ["-c"] }))).toEqual(["sbx", "run", "--name", NAME, "--", "-c"]);
  });
});

describe("the probe and settings argv", () => {
  it.each<[string, string[], string[]]>([
    ["the version probe, which answers without the daemon gate", buildVersionArgs(), ["sbx", "version", "--json"]],
    ["the sandbox list", buildListArgs(), ["sbx", "ls"]],
    ["the spec of one sandbox", buildInspectArgs(NAME), ["sbx", "inspect", NAME, "--json"]],
    ["a settings read", buildSettingsGetArgs("kit.allowedSources"), ["sbx", "settings", "get", "kit.allowedSources"]],
    ["the kit source allowlist", buildAllowedSourcesSetArgs('["docker.io/"]'), ["sbx", "settings", "set", "kit.allowedSources", '["docker.io/"]']],
    ["the docker volume size", buildDockerVolumeSetArgs(), ["sbx", "settings", "set", "sandbox.disk.dockerVolume", "40g"]]
  ])("should build %s", (_name, argv, expected) => {
    // Act / Assert
    expect(argv).toEqual(expected);
  });
});

describe("buildSecretSetArgs", () => {
  it.each(SECRET_SCOPES)("should store the registry secret for $where", (scope) => {
    // Act
    const argv = buildSecretSetArgs(scope.flags);

    // Assert
    expect(argv.slice(0, 3)).toEqual(["sbx", "secret", "set"]);
    expect(argv).toContain("--registry");
    expect(argv).toContain("hmctsprod.azurecr.io");
    expect(argv).toContain("--password-stdin");
    expect(argv[argv.indexOf("--username") + 1]).toBe(TOKEN_USER);
  });

  it("should cover both scopes, since the sandbox's own engine uses a separate secret", () => {
    // Act
    const scopes = SECRET_SCOPES.map((scope) => scope.flags.join(" "));

    // Assert
    expect(scopes).toEqual(["-f", "--all-sandboxes"]);
  });

  it("should never carry the token in argv", () => {
    // Act / Assert
    expect(buildSecretSetArgs(["-f"]).join(" ")).not.toContain("--password ");
  });
});

describe("the staleness az argv", () => {
  it("should ask for the tag's digest", () => {
    // Act / Assert
    expect(buildKitDigestArgs("hmctsprod", "cft-workspace/sbx:latest")).toEqual([
      "az",
      "acr",
      "repository",
      "show",
      "--name",
      "hmctsprod",
      "--image",
      "cft-workspace/sbx:latest",
      "--query",
      "digest",
      "-o",
      "tsv"
    ]);
  });

  it("should ask for the manifest, which is what tells a child digest from a stale one", () => {
    // Act / Assert
    expect(buildKitIndexArgs("hmctsprod", "cft-workspace/sbx:latest")).toEqual([
      "az",
      "acr",
      "manifest",
      "show",
      "-r",
      "hmctsprod",
      "-n",
      "cft-workspace/sbx:latest",
      "-o",
      "json"
    ]);
  });
});
