import { describe, expect, it } from "vitest";
import { hostPrepPaths, isUnder } from "./host-prep.js";
import { defaultSpec } from "./mounts.js";

const HOME = "/home/linus";

describe("hostPrepPaths", () => {
  it("should split the default mount list into the directories and the files to touch", () => {
    // Arrange
    const mounts = defaultSpec({ env: { HOME }, workspaceFolder: "/repo" }).mounts;

    // Act
    const paths = hostPrepPaths({ home: HOME, mounts });

    // Assert
    expect(paths).toEqual({
      dirs: [`${HOME}/.azure`, `${HOME}/.claude`, `${HOME}/.config/gh`, `${HOME}/.config/twg`, `${HOME}/.kube`, `${HOME}/.ssh`],
      files: [`${HOME}/.bash_history`, `${HOME}/.claude.json`, `${HOME}/.zsh_history`]
    });
  });

  it("should leave the named volumes and anything outside HOME alone", () => {
    // Act
    const paths = hostPrepPaths({
      home: HOME,
      mounts: [
        { kind: "volume", source: "hai-gradle", target: "/home/hmcts/.gradle" },
        { kind: "bind", source: "/etc/hosts", target: "/etc/hosts" },
        { kind: "bind", source: "/home/linus2/.claude", target: "/home/hmcts/.claude" }
      ]
    });

    // Assert
    expect(paths).toEqual({ dirs: [], files: [] });
  });

  it("should not repeat a path mounted twice", () => {
    // Act
    const paths = hostPrepPaths({
      home: HOME,
      mounts: [
        { kind: "bind", source: `${HOME}/.claude`, target: "/a" },
        { kind: "bind", source: `${HOME}/.claude`, target: "/b" }
      ]
    });

    // Assert
    expect(paths.dirs).toEqual([`${HOME}/.claude`]);
  });
});

describe("isUnder", () => {
  it.each<[string, string, boolean]>([
    ["the home itself", HOME, true],
    ["a path under it", `${HOME}/.claude`, true],
    ["a sibling with the same prefix", "/home/linus2/.claude", false],
    ["somewhere else entirely", "/var/run/docker.sock", false]
  ])("should classify %s", (_name, path, expected) => {
    // Act / Assert
    expect(isUnder(path, HOME)).toBe(expected);
  });
});
