import { createServer } from "node:net";

export function createNet(): Net {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),

    isPortFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        // Any error reads as taken: a port wrongly skipped costs only its mapping, while
        // one wrongly reported free aborts the whole `docker run`.
        server.once("error", () => resolve(false));
        server.once("listening", () => {
          server.close(() => resolve(true));
        });
        // 0.0.0.0, because that is what `docker run -p` binds, and a listener on
        // 127.0.0.1 alone is enough to make that bind fail.
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
