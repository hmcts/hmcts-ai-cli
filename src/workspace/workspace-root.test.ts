import { describe, expect, it } from "vitest";
import { createFakeFs } from "../__fixtures__/fake-seams.js";
import { findWorkspaceRoot, MANIFEST_FILE } from "./workspace-root.js";

const MANIFEST = `# cft-workspace manifest
defaults:
  org: hmcts
repos:
  apps/pcs/pcs-api:
    url: hmcts/pcs-api
`;

describe("findWorkspaceRoot", () => {
  it("should find the manifest in the current directory", async () => {
    // Arrange
    const fs = createFakeFs({ [`/work/${MANIFEST_FILE}`]: MANIFEST });

    // Act / Assert
    expect(await findWorkspaceRoot({ fs, cwd: "/work" })).toBe("/work");
  });

  it("should walk up to find the manifest", async () => {
    // Arrange
    const fs = createFakeFs({ [`/work/${MANIFEST_FILE}`]: MANIFEST });

    // Act / Assert
    expect(await findWorkspaceRoot({ fs, cwd: "/work/apps/pcs/pcs-api/src" })).toBe("/work");
  });

  it("should stop at the filesystem root rather than loop", async () => {
    // Act / Assert
    expect(await findWorkspaceRoot({ fs: createFakeFs(), cwd: "/work/apps" })).toBeNull();
  });

  it("should ignore a workspace.yaml with no repos key, which is somebody else's file", async () => {
    // Arrange
    const fs = createFakeFs({ [`/work/${MANIFEST_FILE}`]: "packages:\n  - apps/*\n" });

    // Act / Assert
    expect(await findWorkspaceRoot({ fs, cwd: "/work" })).toBeNull();
  });

  it("should not be fooled by an indented repos key", async () => {
    // Arrange
    const fs = createFakeFs({ [`/work/${MANIFEST_FILE}`]: "defaults:\n  repos: none\n" });

    // Act / Assert
    expect(await findWorkspaceRoot({ fs, cwd: "/work" })).toBeNull();
  });

  it("should prefer the nearest manifest", async () => {
    // Arrange
    const fs = createFakeFs({ [`/work/${MANIFEST_FILE}`]: MANIFEST, [`/work/nested/${MANIFEST_FILE}`]: MANIFEST });

    // Act / Assert
    expect(await findWorkspaceRoot({ fs, cwd: "/work/nested/deep" })).toBe("/work/nested");
  });
});
