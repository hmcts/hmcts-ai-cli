export function createNet(): Net {
  return { fetch: (url, init) => globalThis.fetch(url, init) };
}

export interface Net {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
