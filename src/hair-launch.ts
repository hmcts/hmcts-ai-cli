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

  if (mode.kind === "list") {
    // Every candidate's name, because every line is printed. This is the one surface that
    // pays a transcript scan per candidate, and it is the one that has something to show for
    // each of them.
    const named = await resolveNames(seams, offered);
    seams.stdout(named.length === 0 ? `${NOTHING_TO_RESTORE}\n` : `${named.map((record) => describeCandidate(record, seams.cwd)).join("\n")}\n`);
    return;
  }

  // Committed before the handover, and before anything else can run: the resumed
  // session's own hook re-registers it as open within seconds, and `claude -r` on a live
  // session forks a copy of the conversation rather than attaching to it. Every reason a
  // record cannot be resumed — a closed session, a live pid, a directory that is gone —
  // is decided before this point, so nothing after the claim can fail and leave it held.
  const claimed = await claimFirst(seams, offered);
  if (claimed === null) {
    seams.logger.say(NOTHING_TO_RESTORE);
    return await launch({ seams: handover, processArgv: forwarding(mode.forward) });
  }

  // What a conversation is called is Claude Code's to change, and the registry only holds a
  // copy that a `/rename` shortly before the session was lost leaves behind — so the name is
  // read off the transcript, and read **after** the claim, for the one record that was
  // claimed. The candidate order does not depend on a name (`rank(cwd)`, then `at`, then
  // `sessionId`), so this cannot change which conversation is taken, and it is the whole
  // difference between one transcript scan per restore and one per candidate.
  const resolved = await resolveName(seams, claimed);

  seams.logger.say(`restoring ${resolved.name ?? resolved.sessionId} in ${resolved.cwd}`);
  // Nothing here writes the terminal title. Claude Code sets it itself as the TUI mounts,
  // from the name on the argv, and rewrites it as the session's status changes — so a title
  // written here would be overwritten within about a second. See the `--name` note below:
  // passing the name is the whole mechanism, and the only thing ever missing was a name.
  // Resume-by-id is not cwd-scoped, so resuming from the wrong directory would rebind the
  // conversation's project settings, hooks and CLAUDE.md discovery to wherever this
  // terminal happened to be sitting.
  seams.chdir(resolved.cwd);
  return await launch({
    seams: { ...handover, cwd: resolved.cwd },
    // The resolved name goes back on the argv, and that is what puts the tab title back:
    // Claude Code sets the title from `--name` as the TUI mounts and reasserts it as the
    // session's status changes. Measured on 2.1.304 — see CLAUDE.md. The resumed session's
    // own hook also reads it from there, so the registry's copy stays in step; that copy is
    // only ever the fallback, the transcript being where a name is read from.
    //
    // `--name` is itself written to the transcript as a `custom-title` record, so a
    // conversation that only ever had an `ai-title` is pinned to it from the first restore
    // on. That is deliberate and documented in CLAUDE.md — it is what naming a session
    // means, and Claude Code's own `customTitle || aiTitle` shows the same name.
    processArgv: forwarding([RESUME_FLAG, resolved.sessionId, ...nameArgs(resolved.name), ...mode.forward])
  });
}

function nameArgs(name: string | undefined): string[] {
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
