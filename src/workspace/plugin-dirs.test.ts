import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { parsePluginNames, resolvePluginDirs } from "./plugin-dirs.js";

const ROOT = "/work";
const MARKETPLACE = `${ROOT}/.claude-plugin/marketplace.json`;

const MARKETPLACE_JSON = JSON.stringify({
  plugins: [
    { name: "pcs", source: "./apps/pcs/.claude" },
    { name: "dtsse", source: "./apps/dtsse/.claude" },
    { name: "absolute", source: "/opt/plugins/absolute" },
    { name: "no-manifest", source: "./apps/nothing/.claude" }
  ]
});

const FILES = {
  [MARKETPLACE]: MARKETPLACE_JSON,
  [`${ROOT}/apps/pcs/.claude/.claude-plugin/plugin.json`]: "{}",
  [`${ROOT}/apps/dtsse/.claude/.claude-plugin/plugin.json`]: "{}",
  "/opt/plugins/absolute/.claude-plugin/plugin.json": "{}"
};

function resolve(names: string[], files: Record<string, string> = FILES) {
  const seams = createFakeSeams({ files });
  return { seams, result: resolvePluginDirs({ ...seams, root: ROOT, names }) };
}

describe("parsePluginNames", () => {
  it.each<[string, string | undefined, string[]]>([
    ["an unset list", undefined, []],
    ["an empty list", "", []],
    ["one name", "pcs", ["pcs"]],
    ["several names", "pcs,dtsse", ["pcs", "dtsse"]],
    ["names with spaces around them", " pcs , dtsse ", ["pcs", "dtsse"]],
    ["whitespace inside a name, which run.sh also strips", "p cs", ["pcs"]],
    ["empty entries", "pcs,,dtsse,", ["pcs", "dtsse"]],
    ["only separators", ",,", []]
  ])("should parse %s", (_name, list, expected) => {
    // Act / Assert
    expect(parsePluginNames(list)).toEqual(expected);
  });
});

describe("resolvePluginDirs", () => {
  it("should resolve a relative source against the workspace root", async () => {
    // Act
    const dirs = await resolve(["pcs", "dtsse"]).result;

    // Assert
    expect(dirs).toEqual([`${ROOT}/apps/pcs/.claude`, `${ROOT}/apps/dtsse/.claude`]);
  });

  it("should keep an absolute source as it is", async () => {
    // Act / Assert
    expect(await resolve(["absolute"]).result).toEqual(["/opt/plugins/absolute"]);
  });

  it("should do nothing when no plugins were asked for", async () => {
    // Arrange
    const { seams, result } = resolve([]);

    // Act / Assert
    expect(await result).toEqual([]);
    expect(seams.lines).toEqual([]);
  });

  it("should skip, not fail, a name that is not in the marketplace", async () => {
    // Arrange
    const { seams, result } = resolve(["pcs", "nonsense"]);

    // Act
    const dirs = await result;

    // Assert
    expect(dirs).toEqual([`${ROOT}/apps/pcs/.claude`]);
    expect(seams.lines.join("")).toContain("plugin nonsense is not in");
  });

  it("should skip, not fail, a plugin whose directory has no manifest", async () => {
    // Arrange
    const { seams, result } = resolve(["no-manifest", "pcs"]);

    // Act
    const dirs = await result;

    // Assert
    expect(dirs).toEqual([`${ROOT}/apps/pcs/.claude`]);
    expect(seams.lines.join("")).toContain("has no");
  });

  it.each([
    ["a missing marketplace", {}],
    ["an unparseable marketplace", { [MARKETPLACE]: "not json" }],
    ["a marketplace with no plugins array", { [MARKETPLACE]: JSON.stringify({ name: "cft" }) }]
  ])("should ignore the whole list given %s", async (_name, files) => {
    // Arrange
    const { seams, result } = resolve(["pcs"], files);

    // Act
    const dirs = await result;

    // Assert
    expect(dirs).toEqual([]);
    expect(seams.lines.join("")).toContain("could not read");
  });

  it("should ignore marketplace entries that are not name/source pairs", async () => {
    // Arrange
    const odd = JSON.stringify({ plugins: [{ name: "pcs" }, { source: "./x" }, null, { name: "pcs", source: "./apps/pcs/.claude" }] });

    // Act
    const dirs = await resolve(["pcs"], { [MARKETPLACE]: odd, [`${ROOT}/apps/pcs/.claude/.claude-plugin/plugin.json`]: "{}" }).result;

    // Assert
    expect(dirs).toEqual([`${ROOT}/apps/pcs/.claude`]);
  });
});
