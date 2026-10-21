export function createClock(): Clock {
  return { now: () => Date.now() };
}

export interface Clock {
  now(): number;
}
