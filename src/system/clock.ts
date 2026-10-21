export function createClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

export interface Clock {
  now(): number;
  /** Waiting for the nested Docker engine to answer is the only thing that needs this. */
  sleep(ms: number): Promise<void>;
}
