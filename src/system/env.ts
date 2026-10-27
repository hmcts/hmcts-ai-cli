export function createEnv(): Env {
  return { ...process.env };
}

export function isEnabled(env: Env, name: string): boolean {
  return env[name] === "1";
}

export function isSet(env: Env, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== "";
}

/** node:child_process wants a string-valued env; an undefined value in the parent means "not set". */
export function asProcessEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export type Env = Record<string, string | undefined>;
