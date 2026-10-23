import { describe, expect, it } from "vitest";
import { createFakeHiddenInput, createFakeSeams } from "../__fixtures__/fake-seams.js";
import type { AgentHub } from "./agent-hub.js";
import { canPrompt, resolveBedrockKey } from "./bedrock-key.js";

const KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const TYPED = "ABSKVHlwZWQtYnktaGFuZC0wMDAwMDAwMDAwMDA";

function fakeHub(overrides: Partial<AgentHub> = {}): AgentHub & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    baseUrl: "https://hub.test",
    getCredential: async () => null,
    putCredential: async (_kind, value) => {
      puts.push(value);
    },
    ...overrides
  };
}

describe("canPrompt", () => {
  it("should prompt a person at a terminal", () => {
    // Act / Assert
    expect(canPrompt(createFakeSeams())).toBe(true);
  });

  it("should not prompt when stdin is not a terminal", () => {
    // Arrange
    const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([], false) });

    // Act / Assert
    expect(canPrompt(seams)).toBe(false);
  });

  it("should not prompt a virtual agent, whose pane nobody is watching", () => {
    // Arrange
    const seams = createFakeSeams({ env: { AGENT_HUB_LAUNCH_TOKEN: "launch-token" } });

    // Act / Assert
    expect(canPrompt(seams)).toBe(false);
  });
});

describe("resolveBedrockKey", () => {
  it("should use the key already in the environment and ask nobody", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { AWS_BEARER_TOKEN_BEDROCK: KEY } });
    const agentHub = fakeHub({
      getCredential: async () => {
        throw new Error("should not have been asked");
      }
    });

    // Act / Assert
    expect(await resolveBedrockKey({ seams, agentHub, offline: false, byName: false })).toBe(KEY);
  });

  it("should use the key agent-hub holds", async () => {
    // Arrange
    const seams = createFakeSeams();
    const agentHub = fakeHub({ getCredential: async () => KEY });

    // Act / Assert
    expect(await resolveBedrockKey({ seams, agentHub, offline: false, byName: false })).toBe(KEY);
  });

  describe("no key stored", () => {
    it("should prompt, then save the key for next time", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });
      const agentHub = fakeHub();

      // Act
      const key = await resolveBedrockKey({ seams, agentHub, offline: false, byName: false });

      // Assert
      expect(key).toBe(TYPED);
      expect(agentHub.puts).toEqual([TYPED]);
      expect(seams.lines.join("")).toContain("saved to agent-hub");
    });

    it("should say to ask in the DTSSE channel, without inventing a documentation url", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });

      // Act
      await resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: false });

      // Assert
      const said = seams.lines.join("");
      expect(said).toContain("DTSSE channel");
      expect(said).not.toMatch(/https?:\/\//);
    });

    it("should carry on with the key for this session when the hub will not store it", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });
      const agentHub = fakeHub({
        putCredential: async () => {
          throw new Error("PUT failed: 403");
        }
      });

      // Act
      const key = await resolveBedrockKey({ seams, agentHub, offline: false, byName: false });

      // Assert
      expect(key).toBe(TYPED);
      expect(seams.lines.join("")).toContain("using it for this session only");
    });

    it("should fail fast rather than block on a pipe nobody is typing into", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([], false) });

      // Act / Assert
      await expect(resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: false })).rejects.toThrow("stdin is not a terminal");
    });

    it("should refuse an empty key", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput(["   "]) });

      // Act / Assert
      await expect(resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: false })).rejects.toThrow("no Amazon Bedrock API key entered");
    });

    it("should trim what was pasted", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([` ${TYPED} \n`]) });

      // Act / Assert
      expect(await resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: false })).toBe(TYPED);
    });
  });

  describe("a source that is not the hub, which is what a named HAI_ROUTE=bedrock resolves to", () => {
    it("should prompt without asking the hub at all", async () => {
      // Arrange — the hub holds a key, and a named route must not reach it: its sources are
      // the environment and a paste, and `prompt` is what the launch line says it took.
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });
      const agentHub = fakeHub({
        getCredential: async () => {
          throw new Error("should not have been asked");
        }
      });

      // Act
      const key = await resolveBedrockKey({ seams, agentHub, offline: false, byName: true });

      // Assert
      expect(key).toBe(TYPED);
      expect(agentHub.puts).toEqual([TYPED]);
    });

    it("should not claim nothing is stored for you, which nobody checked", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });

      // Act
      await resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: true });

      // Assert
      const said = seams.lines.join("");
      expect(said).toContain("No Amazon Bedrock API key in AWS_BEARER_TOKEN_BEDROCK");
      expect(said).toContain("DTSSE channel");
      expect(said).not.toContain("is stored for you");
    });

    it("should still prefer a key already in the environment", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { AWS_BEARER_TOKEN_BEDROCK: KEY } });

      // Act / Assert
      expect(await resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: true })).toBe(KEY);
    });
  });

  describe("the hub cannot be reached", () => {
    it("should prompt and warn that the key will not be saved", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });
      const agentHub = fakeHub({
        getCredential: async () => {
          throw new Error("fetch failed");
        }
      });

      // Act
      const key = await resolveBedrockKey({ seams, agentHub, offline: false, byName: false });

      // Assert
      expect(key).toBe(TYPED);
      expect(agentHub.puts).toEqual([]);
      expect(seams.lines.join("")).toContain("it will not be saved this time");
    });

    it("should fail fast when it cannot prompt either", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([], false) });
      const agentHub = fakeHub({
        getCredential: async () => {
          throw new Error("fetch failed");
        }
      });

      // Act / Assert
      await expect(resolveBedrockKey({ seams, agentHub, offline: false, byName: false })).rejects.toThrow(
        "could not read your Amazon Bedrock API key from agent-hub"
      );
    });
  });

  describe("offline", () => {
    it("should prompt without touching the hub", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });
      const agentHub = fakeHub({
        getCredential: async () => {
          throw new Error("should not have been asked");
        }
      });

      // Act
      const key = await resolveBedrockKey({ seams, agentHub, offline: true, byName: false });

      // Assert
      expect(key).toBe(TYPED);
      expect(seams.lines.join("")).toContain("HAI_OFFLINE=1");
    });

    it("should fail fast when it cannot prompt", async () => {
      // Arrange
      const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([], false) });

      // Act / Assert
      await expect(resolveBedrockKey({ seams, agentHub: fakeHub(), offline: true, byName: false })).rejects.toThrow("HAI_OFFLINE=1");
    });
  });

  it("should never log the key itself", async () => {
    // Arrange
    const seams = createFakeSeams({ hiddenInput: createFakeHiddenInput([TYPED]) });

    // Act
    await resolveBedrockKey({ seams, agentHub: fakeHub(), offline: false, byName: false });

    // Assert
    expect(seams.lines.join("")).not.toContain(TYPED);
  });
});
