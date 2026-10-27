import { HAIR_BIN, haiScriptPath } from "./claude/hooks.js";
import { forwardsItsOwnSession, NAME_FLAG, parseHairArgs } from "./hair/args.js";
import { claimFirst } from "./hair/claim.js";
import { runHook } from "./hair/hook.js";
import { readRegistry } from "./hair/registry.js";
import { describeCandidate, probeDirs, probeLiveness, resolveName, resolveNames, restoreCandidates } from "./hair/restore.js";
import { launch } from "./launch.js";
import type { Seams } from "./system/seams.js";

export const RESUME_FLAG = "-r";
export const NOTHING_TO_RESTORE = "no conversation is waiting to be restored, so this is a fresh session";
export const ALREADY_RESUMING = "the arguments already say which conversation to open, so nothing is claimed from the registry";

/**
 * `hair` — "hai resume". Claims one conversation out of the registry the hooks maintain and
 * hands it to hai's own `launch()`; it never spawns `claude` itself.
 */
export async function launchHair(deps: { seams: Seams; processArgv: string[] }): Promise<void> {
  const { seams } = deps;
  const mode = parseHairArgs(deps.processArgv);

  if (mode.kind === "hook") {
    return await runHook(seams, { event: mode.event, name: mode.name });
  }

  // hai's own entrypoint: a self-update inside `launch` re-execs this path with the
  // arguments it was given, and by then they are `-r <id>`.
  const handover = { ...seams, scriptPath: haiScriptPath() };

  if (mode.kind === "resume" && forwardsItsOwnSession(mode.forward)) {
    seams.logger.verbose(ALREADY_RESUMING);
    return await launch({ seams: handover, processArgv: forwarding(mode.forward) });
  }

  const { records } = await readRegistry(seams);
  // One reading of the clock for the whole run: a record retired for the probe has to be
  // retired for the decision too, or `hair` can offer one it did not probe.
  const now = seams.clock.now();
  const { candidates: offered, skipped } = restoreCandidates({
    records,
    cwd: seams.cwd,
    now,
    liveness: await probeLiveness({ ...seams, host: seams.hostname, now }, records),
    existingDirs: await probeDirs({ ...seams, now }, records)
  });
  for (const { record, reason } of skipped) {
    seams.logger.verbose(`${record.sessionId}: ${reason}`);
  }

  if (mode.kind === "list") {
    // Every candidate's name: this is the one surface that pays a transcript scan per
    // candidate, because every line it prints carries a name.
    const named = await resolveNames(seams, offered);
    seams.stdout(named.length === 0 ? `${NOTHING_TO_RESTORE}\n` : `${named.map((record) => describeCandidate(record, seams.cwd)).join("\n")}\n`);
    return;
  }

  // Committed before the handover: the resumed session's own hook re-registers it as open
  // within seconds, and `claude -r` on a live session forks a copy rather than attaching.
  const claimed = await claimFirst(seams, offered);
  if (claimed === null) {
    seams.logger.say(NOTHING_TO_RESTORE);
    return await launch({ seams: handover, processArgv: forwarding(mode.forward) });
  }

  // Read after the claim, for the one record claimed: the candidate order does not depend
  // on a name, so one transcript scan per restore rather than one per candidate.
  const resolved = await resolveName(seams, claimed);

  seams.logger.say(`restoring ${resolved.name ?? resolved.sessionId} in ${resolved.cwd}`);
  // Resume-by-id is not cwd-scoped, so resuming from the wrong directory would rebind the
  // conversation's project settings, hooks and CLAUDE.md discovery to this terminal's.
  seams.chdir(resolved.cwd);
  return await launch({
    seams: { ...handover, cwd: resolved.cwd },
    // `--name` is what Claude Code titles the tab from.
    processArgv: forwarding([RESUME_FLAG, resolved.sessionId, ...nameArgs(resolved.name), ...mode.forward])
  });
}

function nameArgs(name: string | undefined): string[] {
  return name === undefined ? [] : [NAME_FLAG, name];
}

/** `forwardArgv` slices the first two words off, so the handover has to look like a process argv; both are padding. */
function forwarding(args: string[]): string[] {
  return ["node", HAIR_BIN, ...args];
}
