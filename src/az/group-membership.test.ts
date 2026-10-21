import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { bedrockGroupId, checkBedrockGroupMembership, DEFAULT_BEDROCK_GROUP_ID, parseCheckMemberGroups } from "./group-membership.js";

const OTHER_GROUP = "11111111-2222-3333-4444-555555555555";

describe("bedrockGroupId", () => {
  it("should default to the DTSSE AI Gateway Bedrock Developer group", () => {
    // Act / Assert
    expect(bedrockGroupId({})).toBe(DEFAULT_BEDROCK_GROUP_ID);
  });

  it.each([
    ["an override", { HAI_BEDROCK_GROUP_ID: OTHER_GROUP }, OTHER_GROUP],
    ["an empty override", { HAI_BEDROCK_GROUP_ID: "" }, DEFAULT_BEDROCK_GROUP_ID]
  ])("should honour %s", (_name, env, expected) => {
    // Act / Assert
    expect(bedrockGroupId(env)).toBe(expected);
  });
});

describe("parseCheckMemberGroups", () => {
  it("should find the group in the value array", () => {
    // Act / Assert
    expect(parseCheckMemberGroups(JSON.stringify({ value: [OTHER_GROUP, DEFAULT_BEDROCK_GROUP_ID] }), DEFAULT_BEDROCK_GROUP_ID)).toBe(true);
  });

  it("should report a missing group as not a member", () => {
    // Act / Assert
    expect(parseCheckMemberGroups(JSON.stringify({ value: [] }), DEFAULT_BEDROCK_GROUP_ID)).toBe(false);
  });

  it("should accept a bare array, which az sometimes returns instead of an envelope", () => {
    // Act / Assert
    expect(parseCheckMemberGroups(JSON.stringify([DEFAULT_BEDROCK_GROUP_ID]), DEFAULT_BEDROCK_GROUP_ID)).toBe(true);
  });

  it.each([
    ["unparseable output", "not json"],
    ["no value array", JSON.stringify({ error: { code: "Forbidden" } })],
    ["a non-array value", JSON.stringify({ value: "nope" })],
    ["null", "null"]
  ])("should report %s as unknown rather than guess", (_name, stdout) => {
    // Act / Assert
    expect(parseCheckMemberGroups(stdout, DEFAULT_BEDROCK_GROUP_ID)).toBeNull();
  });
});

describe("checkBedrockGroupMembership", () => {
  it("should POST checkMemberGroups rather than use a directory read", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: () => ({ stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) }) });

    // Act
    const result = await checkBedrockGroupMembership(seams);

    // Assert
    expect(result).toBe(true);
    const argv = seams.runner.calls[0]?.argv ?? [];
    expect(argv).toContain("https://graph.microsoft.com/v1.0/me/checkMemberGroups");
    expect(argv.join(" ")).not.toContain("ad group member check");
    expect(argv.at(-1)).toBe(JSON.stringify({ groupIds: [DEFAULT_BEDROCK_GROUP_ID] }));
  });

  it("should use the overridden group id", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_BEDROCK_GROUP_ID: OTHER_GROUP }, respond: () => ({ stdout: JSON.stringify({ value: [OTHER_GROUP] }) }) });

    // Act / Assert
    expect(await checkBedrockGroupMembership(seams)).toBe(true);
  });

  it("should report unknown and explain under verbosity when az fails", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, respond: () => ({ code: 1, stderr: "Forbidden" }) });

    // Act
    const result = await checkBedrockGroupMembership(seams);

    // Assert
    expect(result).toBeNull();
    expect(seams.lines.join("")).toContain("could not check Bedrock group membership: Forbidden");
  });

  it("should report unknown when the response cannot be read", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, respond: () => ({ stdout: "{}" }) });

    // Act
    const result = await checkBedrockGroupMembership(seams);

    // Assert
    expect(result).toBeNull();
    expect(seams.lines.join("")).toContain("could not read the checkMemberGroups response");
  });
});
