import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeSeams, packagedRuntime } from "../__fixtures__/fake-seams.js";
import { API_KEY_HELPER_SCRIPT, HELPER_FILE } from "../auth/gateway.js";
import { createFs } from "../system/fs.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../system/state-dir.js";
import { packagedRuntimeDir, RUNTIME_SCRIPTS, stagedRuntimeDir, stageRuntime, stagingDecision } from "./runtime-staging.js";

const HOME = "/home/linus";
const STAGED = `${HOME}/.local/state/hai/runtime`;

describe("stagedRuntimeDir", () => {
  it.each<[string, Record<string, string>, string]>([
    ["under HOME by default", { HOME }, STAGED],
    ["under XDG_STATE_HOME when it is set", { HOME, XDG_STATE_HOME: "/xdg" }, "/xdg/hai/runtime"],
    ["wherever HAI_ENTRYPOINT_DIR says", { HOME, HAI_ENTRYPOINT_DIR: "/opt/mine" }, "/opt/mine"],
    ["under HOME when HAI_ENTRYPOINT_DIR is empty", { HOME, HAI_ENTRYPOINT_DIR: "" }, STAGED]
  ])("should stage %s", (_name, env, expected) => {
    // Act / Assert
    expect(stagedRuntimeDir(env)).toBe(expected);
  });
});

describe("stagingDecision", () => {
  it.each<[string, Record<string, string | null>, string[]]>([
    ["nothing is staged", { a: null, b: null }, ["a", "b"]],
    ["the staged copy differs", { a: "old", b: "b" }, ["a"]],
    ["everything matches", { a: "a", b: "b" }, []]
  ])("should restage when %s", (_name, staged, expected) => {
    // Act / Assert
    expect(stagingDecision({ wanted: { a: "a", b: "b" }, staged })).toEqual(expected);
  });
});

describe("stageRuntime", () => {
  it("should copy every script plus the generated gateway helper", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: packagedRuntime() });

    // Act
    const dir = await stageRuntime(seams);

    // Assert
    expect(dir).toBe(STAGED);
    for (const name of RUNTIME_SCRIPTS) {
      expect(seams.fs.store.get(join(STAGED, name))).toBe(`# ${name}\n`);
    }
    expect(seams.fs.store.get(join(STAGED, HELPER_FILE))).toBe(API_KEY_HELPER_SCRIPT);
  });

  it("should keep the staged copies to the state directory's own permissions", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: packagedRuntime() });

    // Act
    await stageRuntime(seams);

    // Assert
    expect(seams.fs.modes.get(STAGED)).toBe(STATE_DIR_MODE);
    expect(seams.fs.modes.get(join(STAGED, "entrypoint.sh"))).toBe(STATE_FILE_MODE);
  });

  it("should write nothing when the staged copies already match", async () => {
    // Arrange
    const staged = Object.fromEntries(RUNTIME_SCRIPTS.map((name) => [join(STAGED, name), `# ${name}\n`]));
    const seams = createFakeSeams({ env: { HOME }, files: { ...packagedRuntime(), ...staged, [join(STAGED, HELPER_FILE)]: API_KEY_HELPER_SCRIPT } });
    seams.fs.modes.clear();

    // Act
    await stageRuntime(seams);

    // Assert
    expect(seams.fs.modes.size).toBe(0);
  });

  it("should restage only what changed", async () => {
    // Arrange
    const staged = Object.fromEntries(RUNTIME_SCRIPTS.map((name) => [join(STAGED, name), `# ${name}\n`]));
    const seams = createFakeSeams({
      env: { HOME },
      files: { ...packagedRuntime(), ...staged, [join(STAGED, "entrypoint.sh")]: "# an older release\n", [join(STAGED, HELPER_FILE)]: API_KEY_HELPER_SCRIPT }
    });
    seams.fs.modes.clear();

    // Act
    await stageRuntime(seams);

    // Assert
    expect([...seams.fs.modes.keys()]).toEqual([STAGED, join(STAGED, "entrypoint.sh")]);
  });

  it("should fail naming the script when the package is missing one", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act / Assert
    await expect(stageRuntime(seams)).rejects.toThrow("hai's supervisor.sh is missing from the installed package");
  });
});

describe("the shipped runtime scripts", () => {
  it("should all be in the package, next to the built output", async () => {
    // Arrange
    const fs = createFs();

    // Act / Assert
    for (const name of RUNTIME_SCRIPTS) {
      expect(await fs.readText(join(packagedRuntimeDir(), name)), name).not.toBeNull();
    }
  });

  it("should source nvm and sdkman in the entrypoint, which a non-interactive exec has not", async () => {
    // Act
    const entrypoint = (await createFs().readText(join(packagedRuntimeDir(), "entrypoint.sh"))) ?? "";

    // Assert
    expect(entrypoint).toContain("$NVM_DIR/nvm.sh");
    expect(entrypoint).toContain(".sdkman/bin/sdkman-init.sh");
  });

  it("should start dockerd and wait for it in the supervisor", async () => {
    // Act
    const supervisor = (await createFs().readText(join(packagedRuntimeDir(), "supervisor.sh"))) ?? "";

    // Assert
    expect(supervisor).toContain("dockerd");
    expect(supervisor).toContain("tonistiigi/binfmt");
  });
});
