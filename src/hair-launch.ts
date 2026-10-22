import { HAIR_BIN, haiScriptPath } from "./claude/hooks.js";
import { parseHairArgs } from "./hair/args.js";
import { claimFirst } from "./hair/claim.js";
import { runHook } from "./hair/hook.js";
import { readRegistry } from "./hair/registry.js";
import { describeCandidate, probeLiveness, restoreCandidates } from "./hair/restore.js";
import { launch } from "./launch.js";
import type { Seams } from "./system/seams.js";

export const RESUME_FLAG = "-r";
export const NOTHING_TO_RESTORE = "no conversation is waiting to be restored, so this is a fresh session";

/**
 * `hair` — "hai resume". A reboot kills every Claude Code session in every VS Code
 * terminal, and `claude --continue` keys only on cwd, so it cannot tell apart the ten
 * sessions the engineer runs in the same directory. `hair` claims one conversation out of
 * the registry the hooks maintain and hands it to hai.
 *
 * **It never spawns `claude` itself.** The claim ends at an id, and `launch()` is what
 * runs: spawning claude here would bypass `resolveRoute` and `resolveAuth`, including the
 * unconditional Bedrock-developer-group check that exists because one session quietly
 * billed roughly 3.3M tokens to an engineer's personal claude.ai subscription. Delegating
 * also inherits container mode, port publishing and the self-update for nothing.
 */
export async function launchHair(deps: { seams: Seams; processArgv: string[] }): Promise<void> {
  const { seams } = deps;
  const mode = parseHairArgs(deps.processArgv);

  if (mode.kind === "hook") {
    return await runHook(seams, { event: mode.event, name: mode.name });
  }

  const { records } = await readRegistry(seams);
  const liveness = await probeLiveness(seams, records);
  const { candidates, skipped } = restoreCandidates({ records, cwd: seams.cwd, liveness });
  for (const { record, reason } of skipped) {
    seams.logger.verbose(`${record.sessionId}: ${reason}`);
  }

  if (mode.kind === "list") {
    seams.stdout(candidates.length === 0 ? `${NOTHING_TO_RESTORE}\n` : `${candidates.map((record) => describeCandidate(record, seams.cwd)).join("\n")}\n`);
    return;
  }

  // Committed before the handover, and before anything else can run: the resumed
  // session's own hook re-registers it as open within seconds, and `claude -r` on a live
  // session forks a copy of the conversation rather than attaching to it.
  const claimed = await claimFirst(seams, candidates);
  const handover = { ...seams, scriptPath: haiScriptPath(seams.scriptPath) };
  if (claimed === null) {
    seams.logger.say(NOTHING_TO_RESTORE);
    return await launch({ seams: handover, processArgv: forwarding(mode.forward) });
  }

  seams.logger.say(`restoring ${claimed.name ?? claimed.sessionId} in ${claimed.cwd}`);
  // Resume-by-id is not cwd-scoped, so resuming from the wrong directory would rebind the
  // conversation's project settings, hooks and CLAUDE.md discovery to wherever this
  // terminal happened to be sitting.
  seams.chdir(claimed.cwd);
  return await launch({
    seams: { ...handover, cwd: claimed.cwd },
    processArgv: forwarding([RESUME_FLAG, claimed.sessionId, ...mode.forward])
  });
}

/**
 * `forwardArgv` slices the first two words off, so the handover has to look like a real
 * process argv. The two it slices are padding: `launch` reads the interpreter and the
 * script it would re-exec from the seams, never from here.
 */
function forwarding(args: string[]): string[] {
  return ["node", HAIR_BIN, ...args];
}
