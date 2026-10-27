export const MASK = "[redacted]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bABSK[A-Za-z0-9+/=]{16,}/g
];

// Keyed forms keep the key so a log line still says which setting was involved.
const KEYED_SECRET_PATTERN =
  /\b(client_secret|api[_-]?key|password|AccountKey|Ocp-Apim-Subscription-Key|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_OAUTH_TOKEN)(["':=]\s*|\s+)([^\s"';]{8,})/gi;

const SECRET_ENV_KEYS = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  // No route of hai's sets this, but it is a credential by definition and every route clears it.
  "ANTHROPIC_AUTH_TOKEN",
  "AGENT_HUB_LAUNCH_TOKEN"
]);

/**
 * The one list of which environment variables hold a credential. Container mode keeps these off
 * `docker run --env`, where `docker inspect` would read them back, delivering them on a stdin.
 */
export function isSecretEnvKey(name: string): boolean {
  return SECRET_ENV_KEYS.has(name);
}

export function redact(text: string): string {
  let masked = text.replace(KEYED_SECRET_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${MASK}`);
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, MASK);
  }
  return masked;
}

export function redactEnvValue(name: string, value: string): string {
  return SECRET_ENV_KEYS.has(name) ? MASK : redact(value);
}

export function describeEnv(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${redactEnvValue(name, value)}`);
}
