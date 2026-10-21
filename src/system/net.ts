import { createServer } from "node:net";

export function createNet(): Net {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),

    isPortFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        // Any error reads as taken rather than as free: a port reported free that is not
        // aborts the whole `docker run`, and a port wrongly skipped only costs its mapping.
        server.once("error", () => resolve(false));
        server.once("listening", () => {
          server.close(() => resolve(true));
        });
        // 0.0.0.0, because that is what `docker run -p` binds: a listener on 127.0.0.1
        // alone still makes the wildcard bind fail, and so must this probe.
        server.listen({ port, host: "0.0.0.0" });
      });
    }
  };
}

export interface Net {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** A bind probe, so container mode can publish only the ports the host has free. */
  isPortFree(port: number): Promise<boolean>;
}
