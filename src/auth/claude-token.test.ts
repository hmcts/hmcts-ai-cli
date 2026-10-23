import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import type { AgentHub } from "./agent-hub.js";
import { resolveHubClaudeToken } from "./claude-token.js";

const TOKEN = "sk-ant-oat01-from-the-hub";

function fakeHub(getCredential: AgentHub["getCredential"] = async () => null): AgentHub & { kinds: string[] } {
  const hub = {
    kinds: [] as string[],
    baseUrl: "https://hub.test",
    getCredential: async (kind: Parameters<AgentHub["getCredential"]>[0]) => {
      hub.kinds.push(kind);
      return getCredential(kind);
    },
    putCredential: async () => undefined
  };
  return hub;
}

describe("resolveHubClaudeToken", () => {
  it("should ask the hub for the claude kind and hand the token back", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" } });
    const agentHub = fakeHub(async () => TOKEN);

    // Act
    const token = await resolveHubClaudeToken({ seams, agentHub, offline: false });

    // Assert — the bedrock kind is the other route's; this one is `claude`.
    expect(token).toBe(TOKEN);
    expect(agentHub.kinds).toEqual(["claude"]);
  });

  it("should never print the token it fetched", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" } });

    // Act
    await resolveHubClaudeToken({ seams, agentHub: fakeHub(async () => TOKEN), offline: false });

    // Assert
    expect(seams.lines.join("")).not.toContain(TOKEN);
    expect(seams.lines.join("")).toContain("agent-hub supplied the Claude token");
  });

  it("should refuse offline rather than reach the hub, which is a call out", async () => {
    // Arrange
    const agentHub = fakeHub(async () => TOKEN);

    // Act
    const act = resolveHubClaudeToken({ seams: createFakeSeams(), agentHub, offline: true });

    // Assert
    await expect(act).rejects.toThrow("HAI_OFFLINE=1 does not consult");
    expect(agentHub.kinds).toEqual([]);
  });

  it("should say the hub holds nothing rather than fall back to the login on this machine", async () => {
    // Act
    const act = resolveHubClaudeToken({ seams: createFakeSeams(), agentHub: fakeHub(), offline: false });

    // Assert
    await expect(act).rejects.toThrow("holds no Claude token for you");
  });

  it("should name the hub's refusal, which is what an owner gets today", async () => {
    // Arrange — OWNER_READABLE is ["bedrock", "claude_md", "git_identity"], so this kind
    // comes back 403 unless a virtual agent with a launch token asks for it.
    const agentHub = fakeHub(async () => {
      throw new Error("GET /api/agent/credentials/claude failed: 403");
    });

    // Act
    const act = resolveHubClaudeToken({ seams: createFakeSeams(), agentHub, offline: false });

    // Assert
    await expect(act).rejects.toThrow("failed: 403");
    await expect(resolveHubClaudeToken({ seams: createFakeSeams(), agentHub, offline: false })).rejects.toThrow("needs the hub widened first");
  });
});
