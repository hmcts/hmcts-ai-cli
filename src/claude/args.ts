export const CLAUDE_BIN = "claude";

/**
 * hai has no arguments of its own: everything after the executable goes to `claude`
 * verbatim, including nothing at all. There is no parsing step to intercept anything,
 * which is the whole point — `hai doctor`, `hai mcp list` and `hai --help` must reach
 * the real CLI untouched.
 */
export function forwardArgv(processArgv: string[]): string[] {
  return processArgv.slice(2);
}

export function buildClaudeArgs(input: { settings?: string; pluginDirs: string[]; userArgs: string[] }): string[] {
  const argv = [CLAUDE_BIN];
  if (input.settings !== undefined) {
    argv.push("--settings", input.settings);
  }
  for (const dir of input.pluginDirs) {
    argv.push("--plugin-dir", dir);
  }
  return [...argv, ...input.userArgs];
}
