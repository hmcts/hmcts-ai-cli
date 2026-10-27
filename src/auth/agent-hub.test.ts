import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { CREDENTIAL_KINDS, createAgentHub, DEFAULT_AGENT_HUB_SCOPE, DEFAULT_AGENT_HUB_URL } from "./agent-hub.js";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJvaWQiOiJmYWtlIn0.c2ln";
const BEDROCK_KEY = "ABSKQmVkcm9jay1mYWtlLWtleS0wMDAwMDAwMDAw";
const CREDENTIAL_PATH = "/api/agent/credentials/bedrock";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function hub(
  options: { env?: Record<string, string>; respondWith: (call: FetchCall) => Response; azCode?: number } = { respondWith: () => new Response("{}") }
) {
  const fetches: FetchCall[] = [];
  const seams = createFakeSeams({
    env: options.env,
    respond: () => ({ code: options.azCode ?? 0, stdout: JSON.stringify({ accessToken: TOKEN, expires_on: 1800000000 }), stderr: "not logged in" }),
    fetch: async (url, init) => {
      const call = { url, init };
      fetches.push(call);
      return options.respondWith(call);
    }
  });
  return { seams, fetches, api: createAgentHub(seams) };
}

describe("createAgentHub", () => {
  it("should default to the AAT hub and its api scope", async () => {
    // Arrange
    const { api, fetches, seams } = hub({ respondWith: () => new Response(JSON.stringify({ value: BEDROCK_KEY })) });

    // Act
    await api.getCredential("bedrock");

    // Assert
    expect(api.baseUrl).toBe(DEFAULT_AGENT_HUB_URL);
    expect(fetches[0]?.url).toBe(`${DEFAULT_AGENT_HUB_URL}${CREDENTIAL_PATH}`);
    expect(seams.runner.calls[0]?.argv).toContain(DEFAULT_AGENT_HUB_SCOPE);
  });

  it.each(CREDENTIAL_KINDS)("should address the %s kind by its own path", async (kind) => {
    // Arrange
    const { api, fetches } = hub({ respondWith: () => new Response(JSON.stringify({ value: BEDROCK_KEY })) });

    // Act
    await api.getCredential(kind);

    // Assert
    expect(fetches[0]?.url).toBe(`${DEFAULT_AGENT_HUB_URL}/api/agent/credentials/${kind}`);
  });

  it.each([
    ["AGENT_HUB_URL", { AGENT_HUB_URL: "https://hub.local/" }, "https://hub.local"],
    ["a url with several trailing slashes", { AGENT_HUB_URL: "https://hub.local///" }, "https://hub.local"]
  ])("should honour %s", async (_name, env, expected) => {
    // Arrange
    const { api } = hub({ env, respondWith: () => new Response("", { status: 404 }) });

    // Act
    await api.getCredential("bedrock");

    // Assert
    expect(api.baseUrl).toBe(expected);
  });

  it("should honour AGENT_HUB_SCOPE", async () => {
    // Arrange
    const { api, seams } = hub({ env: { AGENT_HUB_SCOPE: "api://other/.default" }, respondWith: () => new Response("", { status: 404 }) });

    // Act
    await api.getCredential("bedrock");

    // Assert
    expect(seams.runner.calls[0]?.argv).toContain("api://other/.default");
  });

  it("should fetch the az token before it reaches out to the hub", async () => {
    // Arrange
    const order: string[] = [];
    const seams = createFakeSeams({
      respond: (argv) => {
        order.push(argv[0] ?? "");
        return { stdout: JSON.stringify({ accessToken: TOKEN }) };
      },
      fetch: async () => {
        order.push("fetch");
        return new Response(JSON.stringify({ value: BEDROCK_KEY }));
      }
    });

    // Act
    await createAgentHub(seams).getCredential("bedrock");

    // Assert
    expect(order).toEqual(["az", "fetch"]);
  });

  it("should ask az for a token only once across several calls", async () => {
    // Arrange
    const { api, seams } = hub({ respondWith: () => new Response(JSON.stringify({ value: BEDROCK_KEY })) });

    // Act
    await api.getCredential("bedrock");
    await api.putCredential("bedrock", BEDROCK_KEY);

    // Assert
    expect(seams.runner.calls.filter((call) => call.argv[0] === "az")).toHaveLength(1);
  });

  describe("getCredential", () => {
    it("should return the stored key", async () => {
      // Arrange
      const { api } = hub({ respondWith: () => new Response(JSON.stringify({ value: BEDROCK_KEY })) });

      // Act / Assert
      expect(await api.getCredential("bedrock")).toBe(BEDROCK_KEY);
    });

    it("should read a 404 as no credential rather than a failure", async () => {
      // Arrange
      const { api } = hub({ respondWith: () => new Response("", { status: 404 }) });

      // Act / Assert
      expect(await api.getCredential("bedrock")).toBeNull();
    });

    it.each([
      ["an empty value", JSON.stringify({ value: "" })],
      ["no value", JSON.stringify({})],
      ["a non-string value", JSON.stringify({ value: 7 })]
    ])("should read %s as no credential", async (_name, body) => {
      // Arrange
      const { api } = hub({ respondWith: () => new Response(body) });

      // Act / Assert
      expect(await api.getCredential("bedrock")).toBeNull();
    });

    it("should throw on any other error status", async () => {
      // Arrange
      const { api } = hub({ respondWith: () => new Response("", { status: 500 }) });

      // Act / Assert
      await expect(api.getCredential("bedrock")).rejects.toThrow("failed: 500");
    });

    it("should surface an az failure rather than guess there is no key", async () => {
      // Arrange
      const { api } = hub({ azCode: 1, respondWith: () => new Response("") });

      // Act / Assert
      await expect(api.getCredential("bedrock")).rejects.toThrow("az account get-access-token failed");
    });

    it("should send a bearer token and no content type", async () => {
      // Arrange
      const { api, fetches } = hub({ respondWith: () => new Response(JSON.stringify({ value: BEDROCK_KEY })) });

      // Act
      await api.getCredential("bedrock");

      // Assert
      expect(fetches[0]?.init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
      expect(fetches[0]?.init?.body).toBeUndefined();
    });

    it("should abort rather than hang", async () => {
      // Arrange
      const { api, fetches } = hub({ respondWith: () => new Response(JSON.stringify({ value: BEDROCK_KEY })) });

      // Act
      await api.getCredential("bedrock");

      // Assert
      expect(fetches[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("putCredential", () => {
    it("should PUT the key as json", async () => {
      // Arrange
      const { api, fetches } = hub({ respondWith: () => new Response("{}") });

      // Act
      await api.putCredential("bedrock", BEDROCK_KEY);

      // Assert
      expect(fetches[0]?.init?.method).toBe("PUT");
      expect(fetches[0]?.init?.body).toBe(JSON.stringify({ value: BEDROCK_KEY }));
      expect(fetches[0]?.init?.headers).toMatchObject({ "Content-Type": "application/json" });
    });

    it("should throw when the hub refuses the write", async () => {
      // Arrange
      const { api } = hub({ respondWith: () => new Response("", { status: 403 }) });

      // Act / Assert
      await expect(api.putCredential("bedrock", BEDROCK_KEY)).rejects.toThrow("failed: 403");
    });
  });
});
