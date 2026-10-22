import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { DEFAULT_BEDROCK_GROUP_ID } from "../az/group-membership.js";
import type { AgentHub } from "./agent-hub.js";
import { CACHE_FILE } from "./auth-cache.js";
import { resolveAuth } from "./resolve-auth.js";

const HOME = "/home/dev";
const CACHE_PATH = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const ACCOUNT = JSON.stringify({ tenantId: "tenant", user: { name: "dev@hmcts.net" } });
const IDENTITY = "tenant:dev@hmcts.net";

const hub = (getBedrockKey: AgentHub["getBedrockKey"] = async () => null): AgentHub => ({
  baseUrl: "https://hub.test",
  getBedrockKey,
  putBedrockKey: async () => undefined
});

function respondAz(argv: string[]) {
  if (argv[1] === "account" && argv[2] === "show") {
    return { stdout: ACCOUNT };
  }
  if (argv[1] === "rest") {
    return { stdout: JSON.stringify({ value: [DEFAULT_BEDROCK_GROUP_ID] }) };
  }
  return undefined;
}

const askedGraph = (calls: { argv: string[] }[]) => calls.some((call) => call.argv[1] === "rest");

describe("resolveAuth", () => {
  it("should cache the group answer under the signed-in identity", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: respondAz });

    // Act
    await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(JSON.parse(seams.fs.store.get(CACHE_PATH) ?? "{}")).toEqual({ [IDENTITY]: { group: { at: FIXED_NOW, isMember: true } } });
  });

  it("should reuse a cached group answer rather than ask Graph again", async () => {
    // Arrange
    const cache = { [IDENTITY]: { group: { at: FIXED_NOW - 1000, isMember: true } } };
    const seams = createFakeSeams({ env: { HOME }, files: { [CACHE_PATH]: JSON.stringify(cache) }, respond: respondAz });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(result).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
    expect(askedGraph(seams.runner.calls)).toBe(false);
  });

  it("should cache nothing when az cannot say who we are", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => (argv[1] === "account" ? { code: 1, stderr: "no" } : respondAz(argv)) });

    // Act
    await resolveAuth({ seams, agentHub: hub(async () => KEY) });

    // Assert
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should ask az nothing at all when offline", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_OFFLINE: "1" } });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert — unknown membership still offers the prompt rather than failing outright.
    expect(result).toMatchObject({ route: "bedrock", credentialSource: "prompt" });
    expect(seams.runner.calls).toHaveLength(0);
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should ask az nothing when the environment already settles the route", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, AWS_BEARER_TOKEN_BEDROCK: KEY } });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert
    expect(result).toMatchObject({ route: "bedrock", credentialSource: "env" });
    expect(seams.runner.calls).toHaveLength(0);
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should fail with all three remedies when no signal fires at all", async () => {
    // Arrange
    const notAMember = (argv: string[]) => (argv[1] === "rest" ? { stdout: JSON.stringify({ value: [] }) } : respondAz(argv));
    const seams = createFakeSeams({ env: { HOME }, respond: notAMember });

    // Act
    const act = resolveAuth({ seams, agentHub: hub() });

    // Assert
    await expect(act).rejects.toThrow(/DTSSE channel[\s\S]*HAI_ROUTE=gateway[\s\S]*claude setup-token/);
  });

  it("should not cache a failure", async () => {
    // Arrange
    const notAMember = (argv: string[]) => (argv[1] === "rest" ? { stdout: JSON.stringify({ value: [] }) } : respondAz(argv));
    const seams = createFakeSeams({ env: { HOME }, respond: notAMember });

    // Act
    await resolveAuth({ seams, agentHub: hub() }).catch(() => undefined);

    // Assert
    expect(seams.fs.store.has(CACHE_PATH)).toBe(false);
  });

  it("should carry on when the cache cannot be written", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, respond: respondAz });

    // Act
    const result = await resolveAuth({ seams, agentHub: hub() });

    // Assert — no HOME means no state dir, which must not stop a launch.
    expect(result.route).toBe("bedrock");
    expect(seams.lines.join("")).toContain("could not write the group-membership cache");
  });

  it("should ask az who we are before it asks agent-hub anything", async () => {
    // Arrange
    const order: string[] = [];
    const seams = createFakeSeams({
      env: { HOME },
      respond: (argv) => {
        order.push(`az ${argv[1]}`);
        return respondAz(argv);
      }
    });
    const agentHub = hub(async () => {
      order.push("hub get");
      return KEY;
    });

    // Act
    await resolveAuth({ seams, agentHub });

    // Assert
    expect(order).toEqual(["az account", "hub get"]);
  });
});
