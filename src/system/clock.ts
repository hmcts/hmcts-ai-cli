export function createClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
