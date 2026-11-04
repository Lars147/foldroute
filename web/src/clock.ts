/** Epoch time in milliseconds; injected clocks keep freshness and deadlines consistent. */
export interface Clock {
  now(): number;
}

// Resolve Date.now at each call so browser clocks and fake timers remain effective.
export const systemClock: Clock = { now: () => Date.now() };
