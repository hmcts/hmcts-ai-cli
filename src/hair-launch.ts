import { HAIR_BIN, haiScriptPath } from "./claude/hooks.js";
import { forwardsItsOwnSession, NAME_FLAG, parseHairArgs } from "./hair/args.js";
import { claimFirst } from "./hair/claim.js";
import { runHook } from "./hair/hook.js";
import { readRegistry } from "./hair/registry.js";
import { describeCandidate, probeDirs, probeLiveness, resolveNames, restoreCandidates } from "./hair/restore.js";
import { writeTerminalTitle } from "./hair/title.js";
import { launch } from "./launch.js";
import type { Seams } from "./system/seams.js";

export const RESUME_FLAG = "-r";
export const NOTHING_TO_RESTORE = "no conversation is waiting to be restored, so this is a fresh session";
export const ALREADY_RESUMING = "the arguments already say which conversation to open, so nothing is claimed from the registry";

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

  // hai's own entrypoint, stated rather than inferred: a self-update inside `launch`
  // re-execs this path with the arguments it was given, and by then they are `-r <id>`.
  const handover = { ...seams, scriptPath: haiScriptPath() };

  if (mode.kind === "resume" && forwardsItsOwnSession(mode.forward)) {
    seams.logger.verbose(ALREADY_RESUMING);
    return await launch({ seams: handover, processArgv: forwarding(mode.forward) });
  }

  const { records } = await readRegistry(seams);
  // One reading of the clock for the whole run: a record that is retired for the probe has
  // to be retired for the decision too, or `hair` spends a `ps` on something it then skips
  // — or worse, offers one it did not probe.
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

  // What a conversation is called is Claude Code's to change, and the registry only holds a
  // copy that a `/rename` shortly before the session was lost leaves behind. Settled once,
  // over the candidates alone, so the tab title, the `--name` that goes back on the argv and
  // `hair --list` cannot disagree about the same conversation.
  const candidates = await resolveNames(seams, offered);

  if (mode.kind === "list") {
    seams.stdout(candidates.length === 0 ? `${NOTHING_TO_RESTORE}\n` : `${candidates.map((record) => describeCandidate(record, seams.cwd)).join("\n")}\n`);
    return;
  }

  // Committed before the handover, and before anything else can run: the resumed
  // session's own hook re-registers it as open within seconds, and `claude -r` on a live
  // session forks a copy of the conversation rather than attaching to it. Every reason a
  // record cannot be resumed — a closed session, a live pid, a directory that is gone —
  // is decided before this point, so nothing after the claim can fail and leave it held.
  const claimed = await claimFirst(seams, candidates);
  if (claimed === null) {
    seams.logger.say(NOTHING_TO_RESTORE);
    return await launch({ seams: handover, processArgv: forwarding(mode.forward) });
  }

  seams.logger.say(`restoring ${claimed.name ?? claimed.sessionId} in ${claimed.cwd}`);
  // Claude Code writes no title of its own at startup — measured on 2.1.304, the only
  // `OSC 0` in a `claude -r` stream sits at the very end of it and is the clear-on-exit,
  // with or without a stored `customTitle`. So a restored conversation comes back under
  // whatever title the terminal had, which after a reboot is the shell's default and says
  // nothing about which of ten tabs holds what. A title set *before* the handover survives
  // for the life of the session and claude clears it when the session ends, so this is the
  // one moment at which it can be put back.
  writeTerminalTitle(seams, claimed.name);
  // Resume-by-id is not cwd-scoped, so resuming from the wrong directory would rebind the
  // conversation's project settings, hooks and CLAUDE.md discovery to wherever this
  // terminal happened to be sitting.
  seams.chdir(claimed.cwd);
  return await launch({
    seams: { ...handover, cwd: claimed.cwd },
    // The resolved name goes back on the argv, because the re-registration the resumed
    // session's own hook writes reads it from there: without it a session started as
    // `hai -n pcs` comes back nameless and every later `hair --list` shows it as
    // "(unnamed)". It is the same value the tab title was just set from, by construction.
    processArgv: forwarding([RESUME_FLAG, claimed.sessionId, ...named(claimed.name), ...mode.forward])
  });
}

function named(name: string | undefined): string[] {
  return name === undefined ? [] : [NAME_FLAG, name];
}

/**
 * `forwardArgv` slices the first two words off, so the handover has to look like a real
 * process argv. The two it slices are padding: `launch` reads the interpreter and the
 * script it would re-exec from the seams, never from here.
 */
function forwarding(args: string[]): string[] {
  return ["node", HAIR_BIN, ...args];
}
