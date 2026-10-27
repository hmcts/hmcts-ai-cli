import { describe, expect, it } from "vitest";
import { defaultSpec, type Mount, parseDevcontainer, parseExtraMounts, renderMount, resolveMounts, substitute } from "./mounts.js";

const HOME = "/home/linus";
const WORKSPACE = "/home/linus/Work/solirius/hmcts";
const VARS = { env: { HOME }, workspaceFolder: WORKSPACE };

/** cft-workspace's own .devcontainer/devcontainer.json, trimmed to the keys container mode reads. */
const DEVCONTAINER = `{
  "name": "cft-workspace",
  "image": "hmctsprod.azurecr.io/cft-workspace/devcontainer:latest",
  "runArgs": ["--network=host", "--privileged"],
  "forwardPorts": [],
  // A line comment, because these files are JSONC.
  "workspaceMount": "source=\${localWorkspaceFolder},target=\${localWorkspaceFolder},type=bind",
  "workspaceFolder": "\${localWorkspaceFolder}",
  "mounts": [
    "source=/var/run/docker.sock,target=/var/run/docker-host.sock,type=bind",
    "source=\${localEnv:HOME}/.claude,target=/home/hmcts/.claude,type=bind",
    "source=\${localEnv:HOME}/.claude.json,target=/home/hmcts/.claude.json,type=bind",
    "source=\${localEnv:HOME}/.zsh_history,target=/home/hmcts/.zsh_history,type=bind",
    "source=\${localEnv:HOME}/.bash_history,target=/home/hmcts/.bash_history,type=bind",
    "source=\${localEnv:HOME}/.azure,target=/home/hmcts/.azure,type=bind",
    "source=\${localEnv:HOME}/.kube,target=/home/hmcts/.kube,type=bind",
    "source=\${localEnv:HOME}/.config/gh,target=/home/hmcts/.config/gh,type=bind",
    "source=\${localEnv:HOME}/.config/twg,target=/home/hmcts/.config/twg,type=bind",
    "source=\${localEnv:HOME}/.ssh,target=/home/hmcts/.ssh,type=bind,readonly",
    "source=cft-gradle,target=/home/hmcts/.gradle,type=volume",
    "source=cft-m2,target=/home/hmcts/.m2,type=volume",
    "source=cft-npm,target=/home/hmcts/.npm,type=volume",
    "source=cft-yarn,target=/home/hmcts/.cache/yarn,type=volume",
    "source=cft-codex,target=/home/hmcts/.codex,type=volume"
  ],
  "containerUser": "hmcts",
  "remoteUser": "hmcts"
}`;

describe("substitute", () => {
  it.each<[string, string, string]>([
    ["the workspace folder", `source=\${localWorkspaceFolder}`, `source=${WORKSPACE}`],
    ["a local env var", `source=\${localEnv:HOME}/.claude`, `source=${HOME}/.claude`],
    ["an unset local env var, as empty", `source=\${localEnv:NOPE}/x`, "source=/x"],
    ["nothing to substitute", "source=cft-gradle", "source=cft-gradle"]
  ])("should substitute %s", (_name, text, expected) => {
    // Act / Assert
    expect(substitute(text, VARS)).toBe(expected);
  });
});

describe("parseDevcontainer", () => {
  it("should produce the mount list from the real devcontainer.json", () => {
    // Act
    const spec = parseDevcontainer(DEVCONTAINER, VARS);

    // Assert
    expect(spec?.mounts).toMatchInlineSnapshot(`
      [
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.claude",
          "target": "/home/hmcts/.claude",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.claude.json",
          "target": "/home/hmcts/.claude.json",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.zsh_history",
          "target": "/home/hmcts/.zsh_history",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.bash_history",
          "target": "/home/hmcts/.bash_history",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.azure",
          "target": "/home/hmcts/.azure",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.kube",
          "target": "/home/hmcts/.kube",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.config/gh",
          "target": "/home/hmcts/.config/gh",
        },
        {
          "kind": "bind",
          "readonly": false,
          "source": "/home/linus/.config/twg",
          "target": "/home/hmcts/.config/twg",
        },
        {
          "kind": "bind",
          "readonly": true,
          "source": "/home/linus/.ssh",
          "target": "/home/hmcts/.ssh",
        },
        {
          "kind": "volume",
          "readonly": false,
          "source": "cft-gradle",
          "target": "/home/hmcts/.gradle",
        },
        {
          "kind": "volume",
          "readonly": false,
          "source": "cft-m2",
          "target": "/home/hmcts/.m2",
        },
        {
          "kind": "volume",
          "readonly": false,
          "source": "cft-npm",
          "target": "/home/hmcts/.npm",
        },
        {
          "kind": "volume",
          "readonly": false,
          "source": "cft-yarn",
          "target": "/home/hmcts/.cache/yarn",
        },
        {
          "kind": "volume",
          "readonly": false,
          "source": "cft-codex",
          "target": "/home/hmcts/.codex",
        },
      ]
    `);
  });

  it("should drop the host's Docker socket, because the session runs its own engine", () => {
    // Act
    const spec = parseDevcontainer(DEVCONTAINER, VARS);

    // Assert
    expect(spec?.mounts.map((mount) => mount.source)).not.toContain("/var/run/docker.sock");
    expect(spec?.mounts.map((mount) => mount.target)).not.toContain("/var/run/docker-host.sock");
  });

  it("should drop --network=host and keep --privileged", () => {
    // Act
    const spec = parseDevcontainer(DEVCONTAINER, VARS);

    // Assert
    expect(spec?.runArgs).toEqual(["--privileged"]);
  });

  it.each<[string, string]>([
    ["the separate-argument form", '{"runArgs":["--network","host","--privileged"]}'],
    ["the joined form", '{"runArgs":["--network=host","--privileged"]}']
  ])("should drop host networking given %s", (_name, json) => {
    // Act / Assert
    expect(parseDevcontainer(json, VARS)?.runArgs).toEqual(["--privileged"]);
  });

  it("should read the container user, which decides where $HOME is inside", () => {
    // Act / Assert
    expect(parseDevcontainer(DEVCONTAINER, VARS)?.containerUser).toBe("hmcts");
    expect(parseDevcontainer("{}", VARS)?.containerUser).toBe("hmcts");
  });

  it.each<[string, string]>([
    ["unparseable JSON", "{ not json"],
    ["a JSON scalar", "7"],
    ["JSON null", "null"]
  ])("should return null for %s, so the built-in list is used instead", (_name, json) => {
    // Act / Assert
    expect(parseDevcontainer(json, VARS)).toBeNull();
  });

  it.each<[string, string]>([
    ["mounts that are not an array", '{"mounts":"nope","runArgs":"nope"}'],
    ["mount entries that are not strings", '{"mounts":[1,null],"runArgs":[1,null]}'],
    ["a mount with no source or target", '{"mounts":["type=bind"]}']
  ])("should ignore %s", (_name, json) => {
    // Act
    const spec = parseDevcontainer(json, VARS);

    // Assert
    expect(spec?.mounts).toEqual([]);
    expect(spec?.runArgs).toEqual([]);
  });

  it("should read readonly in either of the forms these files use", () => {
    // Act
    const spec = parseDevcontainer('{"mounts":["source=/a,target=/b,type=bind,ro","source=/c,target=/d,type=bind,readonly=true"]}', VARS);

    // Assert
    expect(spec?.mounts.map((mount) => mount.readonly)).toEqual([true, true]);
  });
});

describe("defaultSpec", () => {
  it("should bake in an equivalent list for a repo with no devcontainer.json", () => {
    // Act
    const spec = defaultSpec(VARS);

    // Assert
    expect(spec.mounts.map(renderMount)).toMatchInlineSnapshot(`
      [
        "type=bind,source=/home/linus/.claude,target=/home/hmcts/.claude",
        "type=bind,source=/home/linus/.claude.json,target=/home/hmcts/.claude.json",
        "type=bind,source=/home/linus/.zsh_history,target=/home/hmcts/.zsh_history",
        "type=bind,source=/home/linus/.bash_history,target=/home/hmcts/.bash_history",
        "type=bind,source=/home/linus/.azure,target=/home/hmcts/.azure",
        "type=bind,source=/home/linus/.kube,target=/home/hmcts/.kube",
        "type=bind,source=/home/linus/.config/gh,target=/home/hmcts/.config/gh",
        "type=bind,source=/home/linus/.config/twg,target=/home/hmcts/.config/twg",
        "type=bind,source=/home/linus/.ssh,target=/home/hmcts/.ssh,readonly",
        "type=volume,source=cft-gradle,target=/home/hmcts/.gradle",
        "type=volume,source=cft-m2,target=/home/hmcts/.m2",
        "type=volume,source=cft-npm,target=/home/hmcts/.npm",
        "type=volume,source=cft-yarn,target=/home/hmcts/.cache/yarn",
        "type=volume,source=cft-codex,target=/home/hmcts/.codex",
      ]
    `);
    expect(spec.runArgs).toEqual(["--privileged"]);
  });

  it("should mount the same paths the devcontainer does", () => {
    // Act
    const baked = defaultSpec(VARS).mounts.map((mount) => mount.target);
    const real = parseDevcontainer(DEVCONTAINER, VARS)?.mounts.map((mount) => mount.target);

    // Assert
    expect(baked).toEqual(real);
  });

  it("should leave the home paths empty rather than guess when HOME is unset", () => {
    // Act
    const spec = defaultSpec({ env: {}, workspaceFolder: WORKSPACE });

    // Assert
    expect(spec.mounts[0]?.source).toBe("/.claude");
  });
});

describe("resolveMounts", () => {
  const spec = () => parseDevcontainer(DEVCONTAINER, VARS)!;

  it("should keep the devcontainer's own cache volumes, which a hai session now shares", () => {
    // Act
    const mounts = resolveMounts({ spec: spec() });

    // Assert
    expect(mounts.filter((mount) => mount.kind === "volume").map((mount) => mount.source)).toEqual([
      "cft-gradle",
      "cft-m2",
      "cft-npm",
      "cft-yarn",
      "cft-codex"
    ]);
  });

  it("should leave the binds alone", () => {
    // Act
    const mounts = resolveMounts({ spec: spec() });

    // Assert
    expect(mounts.find((mount) => mount.target === "/home/hmcts/.claude")?.source).toBe(`${HOME}/.claude`);
  });

  it("should append HAI_MOUNTS last, so it can override a target", () => {
    // Act
    const mounts = resolveMounts({ spec: spec(), extra: "/tmp/data:/data,/etc/hosts:/etc/hosts:ro" });

    // Assert
    expect(mounts.slice(-2)).toEqual([
      { kind: "bind", source: "/tmp/data", target: "/data", readonly: false },
      { kind: "bind", source: "/etc/hosts", target: "/etc/hosts", readonly: true }
    ]);
  });
});

describe("parseExtraMounts", () => {
  it.each<[string, string | undefined]>([
    ["unset", undefined],
    ["empty", ""],
    ["only separators", ",,"]
  ])("should produce nothing when HAI_MOUNTS is %s", (_name, spec) => {
    // Act / Assert
    expect(parseExtraMounts(spec)).toEqual([]);
  });

  it.each<[string, string]>([
    ["a single field", "/tmp/data"],
    ["an empty target", "/tmp/data:"],
    ["an empty source", ":/data"],
    ["four fields", "/tmp/data:/data:ro:more"],
    ["a third field that is not ro", "/tmp/data:/data:rw"]
  ])("should refuse %s, naming the entry", (_name, spec) => {
    // Act / Assert
    expect(() => parseExtraMounts(spec)).toThrow(`HAI_MOUNTS entry "${spec}"`);
  });
});

describe("renderMount", () => {
  it.each<[string, Mount, string]>([
    ["a bind", { kind: "bind", source: "/a", target: "/b" }, "type=bind,source=/a,target=/b"],
    ["a volume", { kind: "volume", source: "v", target: "/b" }, "type=volume,source=v,target=/b"],
    ["a read-only bind", { kind: "bind", source: "/a", target: "/b", readonly: true }, "type=bind,source=/a,target=/b,readonly"],
    ["readonly false, which is left off", { kind: "bind", source: "/a", target: "/b", readonly: false }, "type=bind,source=/a,target=/b"]
  ])("should render %s", (_name, mount, expected) => {
    // Act / Assert
    expect(renderMount(mount)).toBe(expected);
  });
});
