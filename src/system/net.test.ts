import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createNet } from "./net.js";

// A real listener, arranged with node:http so the probe under test is not the thing that
// also sets the port up. Any TCP listener makes the bind fail the same way.
async function listening(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

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

  it("should report a port nothing is listening on as free", async () => {
    // Arrange
    const { server, port } = await listening();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Act / Assert
    expect(await createNet().isPortFree(port)).toBe(true);
  });

  it("should report a port in use as taken, and leave the listener alone", async () => {
    // Arrange
    const { server, port } = await listening();

    // Act
    const free = await createNet().isPortFree(port);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Assert
    expect(free).toBe(false);
  });

  it("should release the port it probed, so the probe does not become the clash", async () => {
    // Arrange
    const net = createNet();
    const { server, port } = await listening();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Act
    const first = await net.isPortFree(port);
    const second = await net.isPortFree(port);

    // Assert
    expect([first, second]).toEqual([true, true]);
  });
});
