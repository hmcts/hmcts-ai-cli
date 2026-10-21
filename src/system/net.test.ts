import { afterEach, describe, expect, it } from "vitest";
import { createNet } from "./net.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createNet", () => {
  it("should delegate to the global fetch", async () => {
    // Arrange
    const calls: [string, RequestInit | undefined][] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("ok");
    }) as typeof fetch;

    // Act
    const res = await createNet().fetch("https://example.test/x", { method: "PUT" });

    // Assert
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual([["https://example.test/x", { method: "PUT" }]]);
  });
});
