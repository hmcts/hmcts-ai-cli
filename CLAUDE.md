# hmcts-ai-cli

`hai`, a transparent wrapper around the `claude` CLI. Read `README.md` first — it covers
installing it and the environment variables. This file covers only the things an agent
working in this repo needs that the README does not say.

## Commands

```bash
yarn install
yarn lint            # biome check --error-on-warnings .
yarn lint:fix
yarn typecheck       # tsc --noEmit over src/ and *.mts
yarn test
yarn test:coverage   # 90% over src/**, 100% on the pure decision modules
yarn build           # tsc -p tsconfig.build.json -> dist/
```

## Hard rules

- **`hai` has no arguments of its own.** Never add a flag, a subcommand or an argument
  parser. Every argument is forwarded to `claude` verbatim. All configuration is
  `HAI_*` environment variables. `src/claude/args.test.ts` guards this.
- **`hair` may have its own arguments, and that is not a loophole in the rule above.**
  The rule exists because `claude` owns the subcommand namespace: `hai doctor`,
  `hai mcp list` and `hai --help` have to reach the real CLI untouched, and a parser in
  front of them would eventually swallow one. A separate binary is not in that namespace,
  so `hair --list` and `hair hook <Event>` cost nothing — but only in the leading
  position, and never for the bare form. `hair -r x --list` forwards all three words.
  Nothing `hair` parses may reach the forwarded argv.
- **`hair` delegates to `launch()`; it never spawns `claude`.** Its job ends at claiming a
  session id, after which it hands `["-r", id, ...rest]` to hai's own entrypoint.
  Spawning `claude` from `hair` would bypass `resolveRoute` and `resolveAuth` — including
  the Bedrock-developer-group check on the default path, which exists because one session
  silently billed roughly 3.3M tokens to an engineer's personal claude.ai subscription.
  Delegating also inherits container mode, the port publishing and the self-update for
  free. The handover swaps `scriptPath` for `haiScriptPath()`, because a self-update inside
  `launch` re-execs `scriptPath` with the arguments it was given — by then `-r <id>` — and
  re-entering `hair` there would claim a *second* conversation and emit
  `claude -r <new> -r <old>`, where the last wins and the second claim is stranded.
- **Never infer a bin's identity or a sibling's path from `process.argv[1]`.** `argv[1]` is
  the path as invoked, and for the documented global install that is the bin **symlink** —
  `<prefix>/bin/hair`, with no `.js` and no directory in common with `dist/bin`. Node does
  not realpath it (measured on node 24). Two things were quietly dead because of it: the
  `.js` suffix test in `hairCommand`, so even the in-place hook fell back to `hair` on
  `PATH`; and `haiScriptPath`, so the self-update re-entered `hair`. `binPath()` resolves a
  sibling bin from `import.meta.url`, which *is* realpath'd, the same way `packageRoot()`
  does — and "am I hair?" is a fact the `hair` entrypoint states rather than one anything
  sniffs out of a filename.
- **The session registry lives in `~/.claude/sessions.jsonl`, not in hai's state dir.**
  The hook that writes it runs *inside* the container session while `hair` may run on the
  host, and `~/.claude` is one of the few paths bind-mounted across that boundary — the
  state dir would give the two halves two different files. It also has to survive the
  container rebuild a reboot forces. `lockPath` in `src/container/lock.ts` keeps
  host-visible state under `~/.claude` for the same reason.
- **Registration is on the first `UserPromptSubmit` and only for an attended session.**
  After a reboot every entry looks stale-open, so the registry is only useful if it holds
  conversations a human actually drove. `SessionStart` fires for every subagent sweep,
  `-p` script run and background job — cft-workspace starts one from a `SessionStart` hook
  on *every* session — and measured on Claude Code 2.1.304 a `-p` run and a `--bg` session
  fire `UserPromptSubmit` too, with payloads byte-identical to an interactive one. The
  only discriminator is the hook's inherited `CLAUDE_CODE_SESSION_ATTENDED`, which was `1`
  interactive and `0` for both; `CLAUDE_CODE_ENTRYPOINT` is not one, because `--bg` reports
  `cli` just as an attended session does. Filter conservatively: missing a session is a
  nuisance, a registry full of agent runs is useless.
- **`at` is last activity, not registration time, and the refresh is throttled.** The
  candidate order is by recency, which only means anything if `at` moves as a conversation
  is driven. Stamped once it ranks the wrong one first in the ordinary case: A registered
  at 09:00 and worked in all day, B registered at 16:30 with one question and left idle,
  both killed at 17:30 — newest-*registration*-first hands back the one-question
  conversation and leaves the day's work second. So a prompt whose record is older than
  `ACTIVITY_REFRESH_MS` re-registers it. The throttle is the whole design: restamping on
  every prompt would append a line per prompt. Fifteen minutes makes the ordering wrong by
  at most the interval — far finer than the gaps it exists to resolve — and costs a
  busy session of the order of thirty lines a day. Do not take the throttle off to make the
  ordering exact; the exactness is imperceptible and the cost lands on the one operation
  here that can lose data.
- **Open records are retired by age, because nothing else retires them at all.** Only a
  `CONVERSATION_OVER_REASONS` reason writes a tombstone, so every signal-killed session —
  the set this whole mechanism exists to preserve — and every `/resume` departure is
  otherwise permanent. Two things were sized against tombstones and degrade without a bound
  if they are: `probeLiveness` spawns one sequential `ps` per open record on **every**
  `hair` and every `hair --list`, which at the 125 records already in one engineer's
  registry is a second of process spawning before a line is printed; and once the open set
  alone passes `COMPACTION_THRESHOLD`, a rewrite can drop nothing, so `lines >= threshold`
  is permanently true and the one operation that can lose a concurrent append fires on
  every single hook. `RESTORE_WINDOW_MS` is seven days — long enough for a bank-holiday
  weekend, which is the longest ordinary gap between closing an editor and reopening it,
  and retiring a record only stops `hair` *offering* it: Claude Code still holds the
  transcript, so `claude -r` finds the conversation whatever this file says. `keptRecords`
  is the single definition of "worth keeping" and all three readers go through it, so a
  record cannot be dropped by the compaction and offered by the restore.
- **A compaction has to halve the file, not just find it long.** `shouldCompact` is the
  pure decision, and the second half of it is what stops the open set defeating it: with a
  length test alone, an open set bigger than the threshold compacts on every hook while
  removing nothing. Requiring the rewrite to at least halve the file means the file has to
  double before another can qualify, so the work between compactions stays proportional to
  the file whatever the open set does.
- **Deregistration is on `SessionEnd`, and only for the reasons that mean the conversation
  is over.** The asymmetry is still the whole mechanism — an entry the person closed goes,
  an entry a kill ended stays, so "still marked open" *is* the crash signal — but it only
  holds for *those* reasons, because **`SessionEnd` fires on a kill too**. Measured:
  `kill -TERM` on a running `claude` fires it with `reason: "other"`, the same reason a
  finished `-p` run gives (the table under "Session restore" has the whole enum). So
  deregistering on every reason closed the entry of every session that was killed — which
  is precisely the set the registry exists to hold. Closing VS Code stops the devcontainer,
  which SIGTERMs every session in it, so after a restart the registry held 125 records and
  `HAI_VERBOSE=1 hair --list` reported "the session was closed cleanly" about every one of
  them: there was nothing to resume, ever, for anybody. This rule used to claim that "a
  clean exit removes its own entry; a reboot cannot". That was never tested and it was
  false.
  `CONVERSATION_OVER_REASONS` is therefore an **allow-list**, and a short one:
  `prompt_input_exit` (`/exit`) and `clear` (`/clear` ends that id and starts a new one, so
  the old id is not a conversation to hand anyone). It is an allow-list and not a deny-list
  of `other` because the two mistakes are not symmetrical — a reason wrongly left open costs
  one stale line the next `hair` offers and the engineer passes over, a reason wrongly
  deregistered costs the conversation with no trace it ever existed — so a reason a later
  Claude Code adds stays recoverable until somebody measures it.
  **The test is "done with this id", not "deliberate".** That distinction is the whole
  list, and getting it wrong is how `logout` was briefly on it. `/logout` *is* deliberate,
  but it is deliberate about **credentials**: it ends the session and leaves the
  conversation completely resumable, so an engineer who logs out and straight back in would
  have found it tombstoned with nothing saying it had ever existed — the exact asymmetric
  loss the allow-list exists to prevent. `resume` is out for the same reason: an
  interactive `/resume` switch is deliberate but does not *end* the conversation it leaves,
  and that conversation is still worth handing back. Do not add either back on the grounds
  that the engineer meant to do it; they did, and it is not the question.
- **hai writes no terminal title, and must not start. `--name` *is* the title mechanism.**
  Measured on Claude Code 2.1.304 with the TUI actually mounting (the reproduction is in the
  measured-behaviour section below, and the `TERM`/`TERM_PROGRAM` part of it is what makes
  the difference): `claude -n ZZNAMEPROBE` writes `ESC]0;⏳ ZZNAMEPROBE` at byte 142 of 2990
  — at **startup** — rewrites it as the session's status changes, and clears it on exit. So
  Claude Code sets the tab title itself, from the name on the argv, which `hair` already
  passes. Two consequences, and either one on its own kills the idea of writing it from
  here: anything hai wrote would be overwritten within about a second as the TUI mounts, and
  there was never anything to add, because `-n` was already doing it. The binary carries
  `terminalTitle: sessionTitle ?? aiSessionTitle ?? agentTitle ?? haikuTitle ?? "Claude Code"`
  and a `terminalTitleFromRename` setting — that selector is what an outside write was trying
  to pre-empt, and it is not ours to pre-empt.
  **The earlier claim in this file was that Claude Code writes no title at startup, and it
  was wrong.** It came from captures of `claude -r <id>` in which the TUI never mounted, so
  the only `OSC 0` in the stream was the clear-on-exit at the very end; the same harness is
  what produced "`-n` persists/sets nothing". A capture that does not mount the TUI measures
  nothing about what the TUI does. Do not re-derive either claim without `TERM` and
  `TERM_PROGRAM` set and the startup bytes in hand.
  The only thing that was ever missing was a **name to put on the argv**, which is what the
  two rules below are about.
- **A conversation's name comes from its own transcript, and it is read at restore, by
  `resolveName`.** Claude Code appends every name it has for a conversation to the transcript
  as a record of its own, and those records are the source:

  ```
  {"type":"ai-title","aiTitle":"VS Code Claude session restore","sessionId":"<id>"}
  {"type":"custom-title","customTitle":"hai-resume","sessionId":"<id>"}
  ```

  Measured across the **946** conversations on one machine: 194 carry an `ai-title` record, 66
  a `custom-title` record, 220 at least one — and 62 have a `custom-title.json` file, every one
  of them beside the matching `custom-title` record. **Every count in this file excludes the
  `-tmp-*` project directories**, which are probe artefacts and nothing else; including them
  gives 1173 / 278 / 68 / 306 / 63, and those were the figures this file used to carry. One of
  the planted conversations was load-bearing — see the "only source" rule below — so measure
  with them out.
  The `ai-title` half is what makes this general rather than a nicety for the renamed few: it
  is Claude Code's own name for every conversation nobody ran `/rename` on, which is most of
  them. It is read at all because `-n` is the only other source and almost nobody passes it:
  the registry's argv-derived name was empty for all 333 of one engineer's records and
  `hair --list` said "(unnamed)" about every one of them, so every restored session came back
  with no `--name` and therefore no tab title. hai only ever **reads** the transcripts:
  writing into Claude Code's own store on its behalf would make a format change hai's bug to
  own. Every way of not having a name is a silent no-name, because a hook never breaks a
  session.
- **The hook reads no title, and the test that says so is load-bearing.** A record's `name`
  is the argv `-n/--name` and nothing else. The hook *did* read the title on every
  `UserPromptSubmit`, to keep the registry's copy fresh and to catch a `/rename` the
  fifteen-minute throttle would otherwise hide — and once the title moved to the transcript
  that became a full scan per prompt, measured at **402 ms** on a 198 MB conversation. The
  throttle is no defence, because the read fed `hookDecision`'s input and so happened before
  the decision to ignore the prompt — the registration path runs on the throttled ignore too,
  which is most prompts. What killed it is that it bought nothing:
  `resolveName` re-reads the transcript at restore time and that value is what both the
  resumed `--name` and `hair --list` use, so a name in the registry is overwritten at the only
  moment it is read. That leaves `record.name` one job — naming a conversation whose
  transcript is **not there** to be read, which is one deleted since the registration or one
  `findProjectDir` cannot find. **Do not reintroduce the read in any form,
  including a version skipped on the throttled path, and do not bring rename-detection back:
  there is nothing to detect, because the registry's name is never what a restored tab is
  titled from.** `hook.test.ts` asserts that a `UserPromptSubmit` reads `sessions.jsonl` and
  nothing else, through `FakeFs`'s `reads` — an assertion on reads rather than on timing,
  because the cost of this mistake is invisible to every other kind of test.
- **The last `custom-title` record beats the last `ai-title` record, and a positional
  last-of-either rule is a bug.** Measured in one transcript: the last `custom-title` record
  sits at byte 10,697,664 and the last `ai-title` at 10,697,766 — the generated name is the
  *later* of the two — and yet the conversation's real name is the custom one, `hai-resume`.
  Claude Code goes on generating names after a `/rename`, so "whichever came last" hands back
  the name the engineer has already replaced. `/rename` is a person saying what the
  conversation is; an `ai-title` is a guess, and it only wins where nobody has said.
  `pickTitle` is that one line and the scan keeps both so it can be asked.
- **An empty `custom-title` is "no custom title", not a record to skip.** Claude Code takes
  the **last** `custom-title` line and reads `""` as the conversation having no chosen name —
  it deletes `custom-title.json` when it sees one — so a title cleared after a rename has to
  let the `ai-title` through, which is what Claude Code itself would then show. The bug this
  replaced was `parseTitleRecord` dropping an empty record, which left the scan holding the
  last *non-empty* `custom-title`: a cleared conversation came back under its pre-clear name
  and shadowed the generated name Claude Code was displaying. So the empty record is kept
  (`titleRecord` guards the *field*, not the value) and `pickTitle` is where the difference is
  read. Reachable in principle rather than observed: there is no `"customTitle":""` in any of
  the 946 transcripts here, measured. The asymmetry is what decides it — a cleared title read
  as "skip this record" hands back a name the engineer deliberately removed, which is the one
  outcome a person who cleared it has ruled out.
- **`agent-name` is measured redundant, and that is why nothing reads it.** A transcript
  carries a third name record — `{"type":"agent-name","agentName":"…","sessionId":"…"}`, and
  plenty of them: 4156 in the largest conversation here, across three values as that
  conversation was renamed — so the comparison that matters is the **last** of each type, the
  same way `pickTitle` reads them. The 2.1.304 binary's own selector is
  `terminalTitle: sessionTitle ?? aiSessionTitle ?? agentTitle ?? haikuTitle`, which puts the
  agent name ahead of both of ours. So it looked like a divergence worth closing. It is not,
  measured over the 946 real transcripts here:

  | over the 946 | transcripts |
  |---|---|
  | carry an `agent-name` record | 78 |
  | last `agent-name` **differs** from the last `custom-title` | **0** |
  | last `agent-name` equals the last `custom-title` | 64 |
  | no `custom-title` at all, last `agent-name` equals the last `ai-title` | 14 |

  `agentName || customTitle || aiTitle` and `customTitle || aiTitle` therefore give the same
  answer for every conversation on this machine. Adding a record type is a third thing to keep
  in step for a difference nobody can observe, so `pickTitle` stays two records wide. If a
  real divergence ever turns up, `agent-name` goes at the **front** of the chain to match the
  binary — but re-measure first, because this table is the reason it is not there.
- **The transcript is *located*, never derived from `cwd`.** A recorded `slug` names
  `<registryDir>/projects/<slug>/<session-id>.jsonl` exactly and is tried first, one `stat`
  and no scan — `transcriptSlug` takes it out of the `transcript_path` the hook payload
  carries, which is Claude Code's own statement of where it filed the conversation. With no
  slug recorded, or a recorded one that holds no such file, `findProjectDir` scans the
  directories under `projects` for `<session-id>.jsonl`. Session ids are unique, so that is
  exact; a slug derived from `cwd` was a guess, and the measurement is why there is no longer
  one. Against the five open records in one live registry, the cwd-derived slug named the
  directory the transcript is actually in for **two**: `058d3464…` had registered under
  `…/apps/dtsse/.worktrees/dtsse-agent-hub-chatwidth`, `80d1d2d8…` under
  `…/pcs-api/.claude/worktrees/enf-film` and `9b511157…` under this repo's own worktree, while
  all three transcripts are filed under `-home-linus-Work-solirius-hmcts` — the directory each
  session was started from. None of the five carries a `slug` either, because no record
  written before it was recorded does, so the scan is the path the existing registry actually
  takes. The scan costs 64 `stat` calls on that machine and only runs when the fast path
  missed.
  The **slug** is recorded and not the whole path, because `~/.claude` is bind-mounted into a
  container session at a *different* absolute path (`$HOME/.claude` on the host,
  `/home/hmcts/.claude` inside, per `DEFAULT_HOME_BINDS`), so a path written by a hook running
  inside does not resolve for the `hair` reading it on the host. The slug carries no namespace
  and the `~/.claude` root is recomposed by whoever reads it, the same way `registryPath` and
  `claimPath` do. This is the path form of "a pid is never read across a PID namespace".
- **The transcript is the only source. There is no `custom-title.json` fallback, and the
  measurement that argued for one was an artefact of the probe that took it.** Claude Code
  does write that file — 62 of the 946 real conversations here have one — but never without
  the matching `custom-title` record in the transcript beside it, so as a source it is
  strictly redundant. What kept it in the code was the claim that "exactly one conversation of
  the 1171 has the file and no `custom-title` record". That one conversation was
  `608ade44-dff5-41e8-85ca-0fa845037a8b` in `~/.claude/projects/-tmp-titleprobe/`: a
  throwaway session an agent created while measuring this, whose first prompt is
  `say only: hi` and whose title `ZZRESUMETITLE` the same probe planted. A measurement
  contaminating its own subject. Excluding every `-tmp-*` directory, the count is **zero**.
  So `readSessionTitle` reads the transcript and nothing else, and `customTitlePath` /
  `parseCustomTitle` are gone. **Re-adding a second source needs a real conversation the
  transcript cannot name** — one an engineer actually worked in, not one a probe made — and
  the synthetic case above is not evidence for it.
  Worth knowing while weighing that: `claude -n X` writes the `custom-title` *record* and no
  `custom-title.json` at all (measured, `-p` run), so the file is not even where a named
  session's title lands.
- **The scan is one pass that keeps the last of each type, and it does not tail-read.** The
  title records are append-only and in practice land near the end, but density is an
  observation and not a rule: a `/rename` early in a long conversation that was never renamed
  again sits in the first megabyte of a hundred. So `scanTranscriptTitles` reads the whole
  file through `Fs.readLines`, which streams — the largest transcript on this machine is
  **198 MB**, and `readText` would make that one string. What a pass costs, measured warm:
  29 ms for a 10 MB transcript, 137 ms for 68 MB, 402 ms for 198 MB. That is affordable per
  *restore*, which is a handful of candidates once per terminal, and is exactly why it is not
  affordable per *prompt* — see the rule above. `parseTitleRecord` rejects a line on a
  substring test before `JSON.parse` for the same reason; a title record is a handful of lines
  in tens of thousands.
- **The registry's `name` is never the answer while a better one exists, and its only real
  case is a transcript that is gone.** The hook writes only the argv name, and every line
  written before this feature existed has none at all, so the registry cannot be where a tab
  title comes from: `resolveName` reads the transcript and the record's value is the fallback.
  **The fallback is not the `-n/--name` case** — this file used to say it was "the whole of"
  it, and that was false. Measured: `claude -n X` appends
  `{"type":"custom-title","customTitle":"X"}` as **line 1** of the transcript, before the
  first prompt, so `readSessionTitle` answers for a `-n` session like any other. What is left
  for `record.name` is a transcript that is not there to be read — deleted since the
  registration, or filed where `findProjectDir` cannot find it. That is still worth having,
  and it is still what makes a stale registry name harmless and the hook's title read
  deletable; it is just a narrower case than the old wording claimed.
- **`hair` resolves the *claimed* record's name, and `hair --list` resolves every
  candidate's.** Resolving the whole list before the claim was the mistake: each candidate
  costs a full streamed transcript pass — 402 ms on the 198 MB conversation here, and the
  three largest are 199 MB, 138 MB and 68 MB — and the bare form uses exactly one name, the
  claimed record's. After a reboot that made every restoring terminal pay a scan per waiting
  conversation, all of it before the claim was even taken, to throw all but one answer away.
  Moving it after the claim is safe because **the candidate order does not depend on a name**:
  it is `rank(cwd)`, then `at`, then `sessionId`. Do not put a name into that ordering, or
  this becomes a scan of every candidate again by necessity.
  The two paths therefore read the same transcript the same way rather than sharing one array.
  That is what keeps them in step, and they have to be: a conversation that lists under its
  old name and comes back under the new one is a disagreement nobody would think to check, so
  `hair --list` pays the per-candidate cost — it has a name to print for each line, which is
  what makes it the right surface to pay it on. `resolveName` substitutes into the record
  rather than returning a name beside it, so there is one name downstream and not a record's
  and a real one; `describeCandidate` stays pure and keeps taking it as data. Both sit beside
  `probeLiveness` and `probeDirs`, which already do per-candidate I/O over the same list.
- **The first restore pins a conversation's name, and that is what naming a session means.**
  `hair` passes the resolved name as `--name`, and `--name` writes a `custom-title` record
  (line 1 of the transcript, measured). So a conversation that only ever had an `ai-title`
  acquires a `custom-title` equal to it at the first restore and keeps it from then on: a
  later regenerated `ai-title` can never win, because custom beats ai. Names do move — 15 of
  the 194 transcripts carrying an `ai-title` carry more than one distinct value — so this is a
  real effect and not a hypothetical.
  **It is not a divergence from Claude Code and must not be "fixed".** Claude Code's own order
  is `customTitle || aiTitle`, so it shows the same pinned name; a resumed session that had
  been given a name keeps it, exactly as one the engineer renamed does. Reversing the
  precedence to let a fresh `ai-title` through would break the `/rename` case, which is the
  one a person actually asked for.
  What it does mean is that any promise of Claude Code's *current* generated name is
  overstated: it is current **as of the first restore**. Say that, in this file and in the
  README, rather than claiming a conversation always comes back under the name Claude Code
  would generate for it today.
- **An end that was not the person's releases the claim and writes nothing.** That is the
  fourth `hookDecision` verdict, `interrupted`, and the reason it carries a session id
  rather than a record. The entry has to be left byte-identical — it *is* the signal — but
  the claim has to go, because the terminal holding it has ended too and a conversation
  nobody is sitting in should not need a pid read to be offered again. `claimDecision`
  would reclaim it anyway, on `pidAlive` answering false about the pid `hair` itself had,
  and a devcontainer's PID namespace starts at 1 again on every restart: that is one
  needless draw against a reused number. Liveness is still the guard that stops a live
  session being forked, the entry carrying the session's own pid for `restoreDecision`.
- **The claim is atomic and is committed before the handover.** Ten terminals can start at
  once, and the resumed session's own hook re-registers it as open within seconds: a claim
  taken after the exec would let the next terminal pick the same id, and `claude -r` on a
  live session forks a copy rather than attaching, so the engineer would get duplicates of
  one conversation instead of their ten. There is no shell for `flock`, so the primitive is
  `Fs.createExclusive` — `O_EXCL` on `~/.claude/hair-claims/<id>.json`. Reclaiming a stale
  claim goes through a `rename`, the other atomic operation available, so the loser of a
  race finds the file already gone rather than both deciding it was theirs.
- **The claim is not the transcript lock widened.** The lock keys on the project slug and
  asks "may this session write these transcripts at all", answering refuse or reclaim for
  the whole run. A claim keys on one session id and asks "is this conversation mine to
  resume", where the right answer to a no is to try the next conversation. `claimDecision`
  deliberately mirrors `lockDecision`'s shape, and both go through the same `pidAlive`.
- **`pidAlive` is read as liveness, never as identity.** `ps -o comm=` reports
  `MainThread` for a plain node process — measured — so matching the command name to
  defeat a pid the kernel reused would read a live holder as gone. "Alive" being wrong
  about a reused pid strands one conversation; "gone" being wrong resumes a live session
  and forks it. Only one of those is worth risking.
- **A pid is never read across a PID namespace.** The hook records its `CLAUDE_PID` inside
  the session while `hair` may run on the host, and `buildDockerArgs` passes no
  `--pid=host`, so the two numbers are not in the same space. Both directions bite: a
  container pid that happens to exist on the host — low pids are kernel threads, which is
  exactly what comes back after a reboot — hides a crashed conversation for good, and a
  container pid absent on the host reads as gone, so `hair` claims a *live* session and
  forks it. Every record therefore carries the `host` its pid lives on and, in container
  mode, the `container` too. `livenessPlan` probes `ps` only when the record was written
  where we are standing; a record naming a hai container falls back to
  `containerRunning`, which crosses the namespace and is what makes the bare-host flow
  work at all, since a reboot removes every one of those containers. Anything else is
  `null`, which `restoreDecision` already leaves alone.
  The claim file carries its claimer's `host` for the same reason and is never reclaimed on
  a liveness answer from another namespace — a `hair` on the host and a `hair` in a
  devcontainer would otherwise read each other's claims as stale.
- **No pid recorded means unanswerable, not gone.** `CLAUDE_PID` missing from a hook's
  environment registers pid 0, and calling that dead would offer a second terminal the
  conversation it is sitting in.
- **Everything that can stop a record being resumed is decided before the claim.** Closed,
  live, unanswerable, directory deleted — all of it, because `process.chdir` throws and
  the claim is already held by then. A claim taken and a chdir that then throws ends `hair`
  through `reported` with the claim in place, so the next run reclaims the same record and
  fails again, for every conversation, until someone hand-edits the registry. A worktree or
  a clone disappearing under a registered conversation is routine here.
- **`hair` claims nothing when the argv already names a conversation.** `hair -r abc` is a
  natural typo of `hai -r abc` — without `forwardsItsOwnSession` it would claim an
  unrelated conversation, emit `-r <claimed> -r abc`, open `abc` because claude takes the
  last, and leave the claimed one held by a live pid that no other terminal could get past.
- **A hook never breaks a session.** `runHook` swallows everything and returns, so
  `hair hook` exits 0 whatever happened. A lost registration costs one `claude -r` typed
  by hand. Measured: a hook command that does not exist at all leaves the session's output
  and exit status untouched, which is what makes the container-mode `hair`-on-PATH
  fallback safe to degrade.
- **`--settings` is the one deliberate exception, and it stays.** `claude`'s `--settings`
  is last-wins rather than merged, so passing it twice discards hai's own settings
  silently — on the ai-gateway route that drops the `apiKeyHelper` and the session starts
  failing auth a few minutes in. `src/claude/user-settings.ts` therefore lifts a
  user-supplied `--settings` out of the forwarded argv, merges it over hai's with the
  user's keys winning, and emits exactly one. This is not a violation of the rule above
  to be reverted.
- **`hai` never adds `--dangerously-skip-permissions`.** Whether to skip permission prompts
  is the engineer's call, made by typing the flag, which the argv forwarding passes straight
  through. `seedClaudeJson` therefore no longer writes `bypassPermissionsModeAccepted`: the
  sbx kit seeds it because `~/.claude` there is an empty volume, but hai bind-mounts the
  host's real `~/.claude.json`, so seeding it recorded an acceptance of risk in the
  engineer's own config for a prompt hai can no longer raise. Someone who types the flag on
  a host that has never accepted sees that screen once, which is the point.
- **A route is one credential from one source.** `agent-hub` is the Claude token the hub
  holds (its `claude` kind), `byol` is a Claude OAuth credential on this machine,
  `ai-gateway` is the APIM key in the private Key Vault, `bedrock` is
  `AWS_BEARER_TOKEN_BEDROCK` from the environment or a paste. That is what makes "an
  explicit route is obeyed" expressible at all: `bedrock` used to mean an environment key
  *or* a hub-stored key *or* a prompt, three sources behind one name, so there was no
  single thing to go and get and no way to say "no fallbacks".
- **An explicit `HAI_ROUTE` is obeyed: no refusals, no fallbacks, no second source.**
  `explicit()` is a straight mapping, and every way of not having that one credential is a
  failure naming it. Refusing a typed route taught people to go round the refusal; the
  group check below guards the *accident*, which is the unset path. The refusal was also
  wrong on its own terms: agent-hub assigns a virtual agent's route from whether its owner
  holds the `AIGateway.User` **app role**, while the refusal tested membership of an Entra
  **group**, and those two populations need not be the same — so an owner in the group whose
  pod is assigned the personal route had that pod's explicit request refused before anything
  looked at the `CLAUDE_CODE_OAUTH_TOKEN` the pod had already exported. A consequence worth
  knowing: a named route resolves no membership at all, so `src/auth/signals.ts` makes no
  `az account show` and no `az rest checkMemberGroups`, and `src/auth/auth-cache.ts` is
  the default path's alone.
- **How far the credential fetch may look is `resolution.byName`, not `credentialSource`.**
  `resolveBedrockKey` reads agent-hub only when the route was *not* asked for by name: a
  named `HAI_ROUTE=bedrock` is the environment or a paste, full stop, and reading the hub
  anyway both broke "no fallbacks" and made the launch line say `prompt` for a key that had
  come off the hub. The unset path keeps the whole chain, env → agent-hub → prompt, from
  **every** branch that lands on bedrock. `credentialSource` cannot stand in for this and
  keying on it was a bug: `prompt` is also what the AI-Gateway downgrade reports, and there
  a hub read is exactly right — `gatherSignals`' probe may have thrown (a 5xx, or its 15s
  timeout) while the Key Vault failed separately for a VPN that is down, and the two are
  independent. Asking someone to paste a key the hub already holds wastes it and
  `promptAndSave` then PUTs the pasted value over it.
- **The hub read and the hub write stand or fall together.** A key pasted on the unset path
  is saved back, which is what lets the next run find it; a named route neither reads nor
  writes it. An engineer pasting a wrong or expired key under `HAI_ROUTE=bedrock` would
  otherwise overwrite the working key the hub holds and break every later unset-path
  session — the same overwrite hazard that makes the downgrade read the hub first, so the
  two rules have to agree.
- **Not setting a variable is not the same as removing it.** The handover is
  `{ ...process.env, ...buildClaudeEnv(...) }`, so a `CLAUDE_CODE_USE_BEDROCK=1` in a shell
  profile survived into a `byol` session: hai printed "paid for by your own Claude licence"
  and ran on Bedrock. `conflictingEnv(route)` is the pure per-route set of the *other*
  payers' credential and transport variables, dropped from the in-place handover and passed
  to the container as `HAI_UNSET_ENV` for the entrypoint to `unset` — before it exports the
  delivered credentials, so one of ours is never unset. It must stay disjoint from what
  `buildClaudeEnv` sets for the same route, which is asserted per route and per name — an
  `arrayContaining` over the whole list only fails when *every* name is present, so it
  passed with `AWS_REGION` smuggled into one route. cft-workspace's virtual-agent entrypoint
  does the same thing with two `unset` lines, and is the precedent.
- **A base URL is a routing fact, not a tuning knob.** Clearing `ANTHROPIC_CUSTOM_HEADERS`
  and not `ANTHROPIC_BEDROCK_BASE_URL` turned a misroute into an unexplained 401: the header
  carries the APIM key but the URL is what routes, so a shell holding cft-workspace's old
  gateway quadruple, running an explicit `bedrock`, lost the key and the skip-auth flag and
  kept a URL pointing at the gateway — every request reached APIM unauthenticated. Each
  route therefore clears the base URLs it does not set itself, and `ANTHROPIC_BASE_URL` on
  all four, where an inherited value would send a personal OAuth token to a third-party
  endpoint. `ai-gateway` keeps an engineer's `ANTHROPIC_BEDROCK_BASE_URL` because it *sets*
  one through `existingOr`, and that is deliberately the only way to point a route at a
  custom endpoint: nothing in the environment distinguishes a URL set on purpose for this
  session from one a previous route left behind, so the route that owns the variable is the
  only place that question can be answered. A direct-Bedrock proxy consequently cannot be
  expressed today — that wants an `HAI_*` variable of its own, not a silently honoured
  leftover. The genuine knobs `existingOr` exists for, `AWS_REGION` and the model names, are
  deliberately not in the set.
- **`own-licence` and `gateway` are gone, and they fail by name rather than aliasing.**
  `badRouteMessage` names the replacement. `gateway` is the one that had to go: in
  cft-workspace `AGENT_HUB_MODEL_ROUTE=gateway` is a legacy alias meaning **Bedrock** while
  hai's `gateway` meant the AI Gateway — the same word with opposite meanings in two files
  read together. An alias would have kept both alive.
- **The launch line says who pays, unconditionally.** `billingNote` goes through
  `logger.say`, not `logger.verbose`, and is printed before any credential is fetched so it
  is also the answer to "why am I being asked to paste a key". Two routes bill a personal
  Claude licence (`agent-hub`, `byol`) and two bill HMCTS (`ai-gateway`, `bedrock`), and the
  name does not say which. Now that a typed route is obeyed, this is the only thing left
  that catches an `HAI_ROUTE` set deliberately on day one and forgotten in a shell profile
  by day ten.
- **A member of the Bedrock developer group never reaches a personal licence by accident.**
  HMCTS funds their capacity, so billing a personal claude.ai subscription is always the
  wrong outcome, and it is invisible while it happens — one session put roughly 3.3M tokens
  across 20 subagents on an engineer's own account while everybody believed it was on
  Bedrock. The group check therefore sits in `resolveRoute`'s unset path **ahead of** every
  personal-credential branch and is unconditional there: `hasHostClaudeCredential` used to
  be tested first, and since every Claude Code user has a live claude.ai login that made the
  membership branch unreachable, so a missing Bedrock key quietly became "use their own
  subscription". **Do not move that ordering**, and note that a hub-stored Bedrock key is
  one of the signals ahead of it. Membership that could not be confirmed refuses the
  personal branch too, naming `HAI_ROUTE=byol` as the way to say that is genuinely what you
  want — because an unanswered question is not an answer of "not a member".
- **`needsMembership` is what keeps that signal resolved.** The block is only as good as
  `isBedrockGroupMember`, so `src/auth/signals.ts` resolves it for the unset path and no
  longer lets an exported `CLAUDE_CODE_OAUTH_TOKEN` or a host claude.ai login short-circuit
  past it. The things that skip it are a Bedrock key in the environment, any explicit
  `HAI_ROUTE` and a cached answer. The host credential is read *after* the group check and
  only when membership is not confirmed, because for a member the answer could not change
  anything.
- **The AI Gateway's fallback chain never ends at a personal subscription.** Whether the
  gateway works is I/O, not a decision — the APIM key is in a private Key Vault behind the
  F5 VPN — so `resolveRoute` returns `ai-gateway` and `resolveAuth` settles it, downgrading
  to a pasted Bedrock key when the key cannot be read and failing when there is no TTY to
  paste into. Every step of that says out loud which fallback happened and why; silence is
  what let the incident run. `HAI_ROUTE=ai-gateway` fails outright instead of downgrading:
  a named route is one source, and a downgrade would move who pays without being asked.
- **The `agent-hub` route is plumbing the hub does not serve yet.** Its credential is the
  hub's `claude` kind — `claude setup-token` output, which cft-workspace's virtual-agent
  entrypoint exports as `CLAUDE_CODE_OAUTH_TOKEN`, and the one variable `buildClaudeEnv`
  sets for this route. The hub's `OWNER_READABLE` is
  `["bedrock", "claude_md", "git_identity"]`, so today an owner asking for `claude` gets a
  403 and `resolveHubClaudeToken` fails naming the hub. Failing is deliberate: injecting
  nothing would have `claude` fall back to whatever login is in `~/.claude`, which is a
  different licence and a different bill. Widening the hub is a change to the hub.
- **Only a group answer that was freshly fetched is stamped in the cache.** `gatherSignals`
  reports `askedGraph` so `resolveAuth` can tell a Graph answer from a cache hit, and a hit
  writes nothing at all. Persisting whenever `isBedrockGroupMember` was non-null re-stamped
  `at` with the clock on every run, and since `isFresh` is `now - at < 12h` the TTL slid
  forward each launch: anyone running hai at least daily was checked against Graph once,
  ever. A cached `{isMember: false}` then went on routing them to a personal licence after they
  were added to the group — the exact invisible personal spend the group check exists to
  stop. Do not "fix" that by preserving the old `at` on a write: a hit has nothing to write.
  The 12h TTL is deliberate now that it expires, and is discussed next to `CACHE_TTL_MS`.
- **`sbx-hai`'s route note is decide-only.** `resolveAuth({ decideOnly: true })` stops at
  the decision — no VPN probe, no `az keyvault secret show` against the private
  `sps-ai-kv-stg`, no `gateway-token.sh` and nothing through `logger.say`. The note is one
  `logger.verbose` line, so settling the gateway for it put real I/O behind a line most runs
  never print, and when the Key Vault read failed (off the VPN, the common case for
  `sbx-hai`) it announced a Bedrock fallback that is untrue there: `sbx-hai` forwards no
  credential and no route environment, sbx injecting its own. The unset path's refusals
  still apply, so a note hai arrived at by itself can never name a route that would bill a
  member's own subscription. Container mode and the in-place path keep the full behaviour.
- **`HAI_OFFLINE=1` skips what goes over the network, not what is on the machine.** Graph
  and agent-hub are not consulted; `az account show`, the group cache and a claude.ai login
  in `~/.claude` are all read, because none of them is a call out — `az account show` reads
  `~/.azure/azureProfile.json`, which is why it still answers after the refresh token has
  expired. So offline a membership confirmed earlier in the day still decides the unset
  path: a cached member goes to the AI Gateway and a cached non-member reaches their own
  licence with no refusal at all. With nothing cached, membership is genuinely unknown and
  the refusal stands, naming `HAI_ROUTE=byol` (`OFFLINE_MEMBERSHIP_REFUSAL`) rather than the
  `az login` or VPN the flag opted out of. `HAI_OFFLINE=1 HAI_ROUTE=byol` is obeyed, as every
  typed route is; what it costs is `HAI_ROUTE=agent-hub`, whose one source is a call out, so
  that combination fails rather than falling back to the login on this machine.
- **The offline cache lookup goes through `readAzAccount`, and that is the whole point.**
  The key has to be byte-identical online and offline or an answer written online is never
  found offline, which is the bug class that made the old route cache dead. Parsing
  `azureProfile.json` here instead would be a second way of deriving it and a second thing
  to keep in step; one function, one key.
- **No credential is ever written to disk.** The caches in `src/auth/auth-cache.ts` and
  `src/container/acr.ts` hold decisions, not secrets.
- **The update check is never cached.** It is one GET behind a 1.5s timeout that already
  fails silently, so a cache saved about 100ms and bought an `update.json` whose TTL kept a
  published release invisible for hours. A leftover `update.json` is simply never read.
- **The in-place handover sets no `HAI_IN_CONTAINER` / `HAI_ENV_READY`.** It exec's
  `claude` in place, so a marker set there is inherited by every shell and tool in the
  session, and from then on every nested `hai` takes the short-circuit in `src/launch.ts`
  and returns before the update check — permanently. Only the container `hai` starts gets
  them, as `--env` in `src/container/run.ts`, where they are true of the whole container.
- **Every log line and error goes through `redact()`.** `createLogger` applies it, and
  `main` routes every thrown error through the logger. Do not write to stderr directly.
- **Only `src/system/runner.ts` imports `node:child_process`; only `src/system/fs.ts`
  imports `node:fs`; only `src/system/net.ts` imports `node:net`.** Enforced by Biome's
  `noRestrictedImports` with per-file overrides, and `ci.yml` asserts Biome inspected a
  non-zero file count so a misconfigured `files.includes` cannot pass as a clean run.
- **Never a shell.** `Runner` spawns `argv[0]` directly with `shell: false`.
- **The hmcts-lib feed allows anonymous reads, so the self-update needs no credential.**
  The packument and the tarballs answer without an `Authorization` header — measured — so
  the version check is a plain `fetch` and the install is `npm install -g <pkg>
  --registry=<feed>`. Nothing is written to disk and nothing secret goes in argv. Only
  *publishing* needs a PAT, and that lives in `.github/workflows/release.yml`. Do not add
  an `.npmrc` or a token mint back.
- **Never `sudo`.** An unwritable install prefix prints the command instead;
  `detectPackageManager` is given `prefixWritable` up front so that is a decision, not a
  failed install.
- **No secret ever reaches `docker run`.** Anything in `--env` or `--env-file` is recorded
  in the container's config, readable afterwards with `docker inspect` and written to disk
  with the container. `splitEnv` divides the route's environment on `isSecretEnvKey`; the
  secret half goes in one credential per `docker exec -i` stdin, onto a `0700` tmpfs, and
  the entrypoint exports and deletes each one. `ContainerContext` holds only the open half
  (as `sessionEnv`), so no argv builder can reach a secret even by mistake; the secret half
  is `LaunchContext`'s and only `deliverSecrets` sees it.
- **The route's environment goes on the session's `docker exec`, never on `docker run`.**
  `--env` on a create is create-time only, and `lockDecision` reattaches a second session to
  the container the first one started — `sessionName` is a hash of the repo path, so two
  terminals in one repo share it. A payer fact passed at create time is therefore the
  *first* session's for every session after it: `HAI_ROUTE=bedrock` reattaching to a `byol`
  container got its bearer token, which does arrive per session on the exec stdin, with no
  `CLAUDE_CODE_USE_BEDROCK` to switch it on and the first session's `HAI_UNSET_ENV` still in
  force, so `claude` fell back to the bind-mounted `~/.claude` login — a personal session hai
  had just announced as HMCTS's. The mirror case kept the first session's
  `CLAUDE_CODE_USE_BEDROCK=1`. So `ctx.env` holds only facts about the whole container (the
  markers, the secrets dir, the nested DNS, the passthrough) and `ctx.sessionEnv` holds this
  session's route. `docker exec` inherits the container's environment and these go over it.
  (`passthroughEnv` is still on the create, so `HAI_VERBOSE` and `HAI_ROUTE` inside a
  reattached session are the first session's. They decide no credential, but they are the
  remaining asymmetry if one turns out to matter.)
- **`buildClaudeEnv` is the only way a credential reaches a container session.**
  `passthroughEnv` carries no credential-bearing name by design, so whatever
  `buildClaudeEnv` leaves out simply is not there inside. That is why `byol` returns an
  exported `CLAUDE_CODE_OAUTH_TOKEN` rather than `{}`: with `{}` a container session on
  `byol` fell back to the bind-mounted `~/.claude` login, which is a different licence and a
  different bill — the same class of mistake as discarding the `agent-hub` token. Both names
  are in `isSecretEnvKey`, so both travel on the `docker exec` stdin and neither appears in
  `docker run` argv. In place the value is the one the process already had, so repeating it
  changes nothing. A `byol` session whose credential genuinely *is* the `~/.claude` login
  needs nothing injected: that directory is bind-mounted.
- **Clearing a credential the engineer exported is said out loud; clearing a switch is not.**
  `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are cleared on every route, so someone
  whose only credential was one of them would otherwise meet claude's own "invalid API key"
  with nothing anywhere saying hai had taken it away. `isSecretEnvKey` is the discriminator —
  which is why `ANTHROPIC_AUTH_TOKEN` is now in it; no route sets it, but it is a credential
  by definition and `redact` should have been masking it too. A switch stays at
  `logger.verbose`: it is worth recording, but nothing of theirs went missing.
- **The container never gets host networking.** A second `dockerd` sharing the host's
  network namespace reconfigures the host's `docker0` and flushes the host daemon's
  iptables chains, breaking every container on the machine. `--network=host` is therefore
  stripped out of the devcontainer's `runArgs` (`DROPPED_RUN_ARGS`) and the session runs on
  a user-defined bridge. `--privileged` stays; the host's Docker socket does not
  (`DROPPED_MOUNT_SOURCES`) — the session runs its own engine.
- **A private network namespace cannot reach `127.0.0.53`, so the VPN resolvers are passed
  explicitly.** `src/container/dns.ts` finds the link whose *routing* domains include
  `~internal` or `~hmcts.net` — that is how the F5 client publishes them, and they are
  per-link, so they never appear in systemd-resolved's global uplink list. Those servers go
  first and `8.8.8.8` trails for the case where the VPN drops. Measured: the HMCTS
  resolvers answer public names too, so ordering them first costs nothing, and the glibc
  "no failover on NXDOMAIN" trap does not apply because an unreachable server times out
  instead. On macOS no `--dns` is passed at all: Docker Desktop's resolver already proxies
  the host. **When no link carries the internal domains, say so and start anyway** — never
  substitute a public resolver as the only server, or every internal name becomes a
  confident NXDOMAIN.

## Shape

```
src/system/     the seams: Runner, Fs, Clock, Net, Env, HiddenInput, chdir, stdin, hostname,
                plus createSeams()
src/log/        redact() and the logger everything speaks through
src/az/         az CLI calls: token, account, checkMemberGroups, Key Vault
src/auth/       route resolution, the agent-hub client, credentials, the env to inject
src/net/        the VPN probe (informational only, never blocks)
src/claude/     the claude argv, the settings and the session-registry hooks hai injects
src/hair/       `hair`: the session registry, the restore candidates, the claim, the hook,
                the terminal tab title
src/workspace/  cft-workspace detection and plugin-dir resolution
src/update/     the Azure Artifacts feed and the self-update
src/container/  container mode: the docker argv, mounts, DNS, ports, the port watch, lock, ACR, staging
src/sbx/        Docker Sandboxes mode: the sbx argv, the kit and the host settings it needs
src/launch.ts   `hai`'s orchestration; src/sbx-launch.ts is `sbx-hai`'s,
                src/hair-launch.ts is `hair`'s and ends by calling launch()
src/main.ts     wraps any of them in error handling: main(), sbxMain() and hairMain()
src/bin/        three two-line shims, excluded from coverage
runtime/        the shell the container runs, shipped in the package and staged at launch
```

Pure functions over gathered facts, with the I/O separated out, so the decisions are
table-testable:

| Pure | I/O that feeds it |
|---|---|
| `resolveRoute(signals)`, `billingNote`, `badRouteMessage` | `gatherSignals` |
| `buildClaudeEnv(input)` | `resolveBedrockKey`, `resolveHubClaudeToken`, `prepareGateway` |
| `isInContainer(probe)` | `probeContainer` |
| `skipUpdateCheck(input)` | `maybeSelfUpdate` |
| `detectPackageManager(input)` | `maybeSelfUpdate` |
| `packumentUrl(feed, name)`, `latestFromPackument(body)` | `maybeSelfUpdate` |
| `extractUserSettings(argv)`, `mergeSettings(ours, theirs)` | `readUserSettings` |
| `shouldRegisterSession`, `sessionDisplayName`, `hookCommand`, `hairCommand`, `binPath` | `sessionRegistryHooks` |
| `parseHairArgs`, `forwardsItsOwnSession` | — |
| `parseRegistry`, `parseRecord`, `retired`, `keptRecords`, `compacted`, `shouldCompact`, `registryPath`, `claimPath` | `readRegistry`, `appendRecord`, `compactRegistry` |
| `restoreDecision`, `restoreCandidates`, `describeCandidate`, `livenessPlan` | `probeLiveness`, `probeDirs`, `resolveName`, `resolveNames` |
| `transcriptSlug`, `projectsDir`, `transcriptPath`, `parseTitleRecord`, `pickTitle` | `findProjectDir`, `scanTranscriptTitles`, `readSessionTitle` |
| `claimDecision`, `parseClaim` | `claimFirst` |
| `hookDecision`, `parsePayload` | `runHook` |
| `resolvePluginDirs` is the exception — it reads the marketplace itself | — |
| `buildDockerArgs(ctx)` | `gatherContext` in `src/container/run.ts` |
| `selectDnsServers`, `parseResolvectl`, `parseNetif`, `parseNmcli` | `discoverDns` |
| `parseDevcontainer`, `defaultSpec`, `resolveMounts`, `hostPrepPaths` | `readSpec`, `prepareHost` |
| `selectPorts`, `publishArg`, `parseEphemeralLow` | `chooseFreePorts`, `readEphemeralLow` |
| `parseProcNet`, `addressKind`, `listeners`, `createDebounce` | the tick in `createPortPublisher` |
| `pendingPorts`, `buildSidecarArgs`, `sweepIds`, `describePortEntry` | `startPortWatch`, `sweepSidecars` |
| `sessionName`, `projectSlug` | — |
| `lockDecision`, `parseLock` | `takeLock` |
| `needsAcrLogin`, `shouldPull`, `dockerConfigJson` | `pullImage` |
| `mergeClaudeJson` | `seedClaudeJson` |
| `stagingDecision` | `stageRuntime` |
| `splitEnv`, `passthroughEnv` | — |
| `buildCreateArgs`, `buildReattachArgs` | `gatherContext` in `src/sbx/run.ts` |
| `parseSbxVersion`, `daemonMismatch` | `requireSbxDaemon` |
| `allowedSourcesDecision`, `sizeMib`, `volumeSizeDecision` | `allowKitSource`, `raiseDockerVolume` |
| `parseKitRecord`, `kitComparable`, `kitStaleness`, `parseIndexDigests` | `warnIfKitStale` |

Keep that split when adding anything: the decision goes in a pure function with a
table-driven test, the probing goes next to it.

## Container mode

`hai` on a bare host is container mode: it runs `claude` inside the CFT workspace image
with a nested Docker engine. `isInContainer` decides which way it goes — already inside a
container or a sandbox keeps the old behaviour, which is to resolve the route, set the
environment and hand over to `claude` in place.

The shape of a launch, all in `src/container/run.ts`:

1. The **route is resolved on the host**, not inside. That is where `az`, the agent-hub and
   the Key Vault are reachable, and on macOS a mounted `~/.azure` may hold no usable
   session at all.
2. `gatherContext` collects the facts; `buildDockerArgs(ctx)` turns them into the argv.
3. Host prep mirrors `devcontainer.json`'s `initializeCommand` — every bind source has to
   exist, and `~/.claude.json` has to exist *as a file* or Docker creates a directory at it
   and nothing starts. `~/.claude.json` is then merged, never overwritten.
4. `runtime/*.sh` is staged into the state directory, content-hash gated, and bind-mounted
   at `/opt/hai:ro`. It is invoked as `bash /opt/hai/<script>` so the staged copies need no
   execute bit. A global install's `node_modules` is not somewhere to mount from.
5. `docker run -d` runs the supervisor as root, because `dockerd` must be. The interactive
   session is a second `docker exec --user <containerUser>` — **by name**, because
   `--user 1000:1000` sets exactly that uid and gid and drops the supplementary groups, so
   the session would not be in `docker` and could not reach the nested socket.
6. The entrypoint **must** source `~/.nvm/nvm.sh` and `~/.sdkman/bin/sdkman-init.sh` first:
   `docker exec` runs it under non-interactive bash with no rc file, and without those
   `claude`, `node`, `java` and `gradle` are all absent.
7. `Runner.interactive` rather than `Runner.exec`, so there is still a process to remove the
   container and release the lock when the session ends.

Other things that are the way they are for a reason:

- **The repo is bind-mounted at its own host path.** That is what makes Claude Code's
  project slug match a host session's, so the conversation history carries over — and it is
  why the transcript lock in `src/container/lock.ts` exists at all, since a host session and
  a container session would otherwise write the same transcript. A stale lock is reclaimed
  silently; an unanswerable question about the holder is *not* grounds to take it.
- **The devcontainer's own `cft-*` cache volumes.** A session therefore starts with the
  Gradle, Maven, npm, yarn and codex caches the engineer already has, at the cost of
  contending for the same Gradle lock when a hai session and a devcontainer build at once.
  The nested engine's `/var/lib/docker` volume is named per session and is not one of these.
- **The nested daemon needs its own `daemon.json` DNS.** On a user-defined bridge this
  container's `/etc/resolv.conf` is Docker's `127.0.0.11`, a loopback address the nested
  `dockerd` discards — so without `HAI_NESTED_DNS` its containers fall back to a public
  resolver and lose every internal name.
- **The nested daemon also needs its own registry login.** The token is minted on the host
  and delivered on the same exec-stdin channel; it lives on the secrets tmpfs with
  `~/.docker/config.json` symlinked at it, so it is where every tool looks without being
  written to a disk. `az account get-access-token` is the session probe, not
  `az account show`, which still answers after the refresh token has expired.
- **The image is pulled on every launch.** `HAI_PULL` defaults to `always`, so a session never
  starts on a silently stale image, and the three policies mean what the same words mean to
  `docker run --pull`: `missing` pulls only when the image is absent, `never` never. An
  always-pull default is only safe because `pullImage` throws **only** when the pull failed
  *and* the image is not on the machine — offline, with the VPN down or with an expired `az`
  session the launch carries on with the cached copy. Keep that degradation.
- **Ports are published dynamically, as the session turns out to listen on them.** A
  hand-maintained list of 20 CFT ports was wrong for every repo that is not CCD or PCS and
  clashed with whatever else the engineer was running, so `docker run` publishes nothing at
  all. Instead `src/container/port-watch.ts` polls
  `docker exec <session> cat /proc/net/tcp /proc/net/tcp6` every two seconds and publishes
  each new listener it finds. That is also what catches the case that matters: when cftlib
  runs `docker compose` on the **nested** daemon, each inner container's `-p` becomes a
  docker-proxy listener in the session container's own network namespace, so it shows up in
  those tables like any other server. The parsing, the loopback rules and the debounce are a
  port of cft-workspace's `scripts/lib/agent-hub/ports.mjs`, which reads the same two tables
  inside a virtual agent's pod.
- **Publishing is a socat sidecar per port, not a host-side proxy.** Docker cannot add a
  mapping to a running container — `docker update` has no `--publish` and mappings are
  create-time only — so each port gets its own `alpine/socat` container on the same
  user-defined network, created with a real `-p` and forwarding to the session by name. A
  host process forwarding to the session's own address was the alternative: it works on
  Linux and is dead on Docker Desktop, where the bridge lives inside the VM and 172.17.x.x
  is unreachable from the Mac. Every sidecar carries `hai.session=<name>`, and that label is
  swept with `docker rm -f` both before a container is created and after its session ends,
  because a sidecar outliving its session holds a host port whose server is already gone.
  **The pre-create sweep stays** now that nothing is probed before the container starts: a
  SIGKILLed session's sidecar still holds its host port with nothing behind it, and the
  watcher would read its own corpse as a clash and skip the port for the session. A session
  that is still up owns its sidecars, so a reattach sweeps nothing.
- **Published ports bind `127.0.0.1`, not `0.0.0.0`.** Docker's iptables chain bypasses the
  host firewall, so a published port answers anyone on the network whatever ufw says — and
  `describePortEntry` reports `http://localhost:<port>`, which says loopback. Publishing is
  automatic now, so the binding matches the URL; `HAI_PORTS_PUBLIC=1` restores `0.0.0.0` for a
  session that has to be reached from another device. cftlib publishes 3000, 6432, 5062 and
  9200 on `0.0.0.0` itself, so for those this changes nothing; what it covers is the ports
  nobody chose.
- **The host's ephemeral range is never published.** Testcontainers publishes each container
  to a random host port, which is a docker-proxy LISTEN in the session's namespace like any
  other, so a `./gradlew integration` run would otherwise leave a sidecar and a held host port
  per mapping for the rest of the session — each *accepting* connections and failing against a
  dead target. `readEphemeralLow` reads `/proc/sys/net/ipv4/ip_local_port_range` and any
  candidate at or above its low bound is dropped, falling back to 32768 where the file is
  absent. Every port a CFT stack listens on is well below it.
- **The watcher prints nothing.** Claude Code's TUI owns the terminal from the moment the
  session starts, so every decision goes to `<state>/ports/<session>.log` and the ports with
  what became of each to `<state>/ports/<session>.ports.json` — and to
  `/tmp/hai-ports.json` inside the session, which is how the agent in there discovers the
  URLs its own servers answer at. The state is emptied as the watch starts, the session name
  being stable per repo: a session that publishes nothing must not leave the last one's URLs
  in place with a fresh timestamp over them. The only thing said on the terminal is what
  stopped the watch from starting at all, which is said before the handover.
- **A port is decided once, and a clash is skipped, never remapped.** cftlib's IDAM
  simulator issues and validates tokens on a fixed port, so a port moved to another number
  breaks XUI's sign-in redirect. The watcher goes through `chooseFreePorts`, which is a bind
  probe on the host and nothing more. A port skipped stays skipped for the session rather
  than being retried every tick, and a listener bound to `127.0.0.1` inside is reported once
  as loopback-only with the "bind it to 0.0.0.0" hint, no sidecar being able to reach it.
  The race between that probe and the sidecar's own `docker run -p` cannot be closed, only
  reported, which is why `describePortEntry` reads "port is already allocated" out of the
  daemon's refusal and says the port was free moments earlier rather than printing an error
  that looks like a hai bug. `HAI_NO_PORT_WATCH=1` turns the watcher off, and with it all
  publishing.

`HAI_FORCE_HOST=1` forces container mode — it overrides both the probe and
`HAI_FORCE_CONTAINER`, and it is the only way to exercise container mode from inside a
devcontainer, which otherwise detects itself and takes the in-place path.

## Session restore (`hair`)

The third bin. A reboot ends every Claude Code session at once, `claude --continue` keys
only on cwd so it cannot tell apart the sessions an engineer runs in one repo, and
`claude -r` on a live session forks a copy of it. `hair` keeps a registry of the
conversations that were open and hands one back per terminal.

The shape, all in `src/hair-launch.ts`:

1. `parseHairArgs` splits the three surfaces: `hair hook <Event>`, `hair --list` and the
   bare form.
2. `readRegistry` folds `~/.claude/sessions.jsonl` to one record per session id, later
   lines winning. It is append-only: a registration is one `O_APPEND` write of one short
   line, which is how ten sessions record themselves with no lock, a refresh is another,
   and a deregistration is a tombstone appended after them. `compactRegistry` rewrites it
   when `shouldCompact` says so — the one operation that can lose a concurrent append, so
   it needs the file both past `COMPACTION_THRESHOLD` and at least halved by the rewrite.
3. `probeLiveness` works out per record how its pid can be asked about at all
   (`livenessPlan`) and then asks — `pidAlive` in the same namespace, `containerRunning`
   across one, nothing when the two cannot be compared. Only the `keptRecords`: a
   tombstone's answer is thrown away and a retired record's is never wanted, and one
   sequential `ps` per record is the cost `RESTORE_WINDOW_MS` exists to bound. `probeDirs`
   checks each distinct kept directory once.
4. `restoreCandidates` turns all of that into the ordered list. An open record touched
   inside the window, whose directory is still there and whose process is **gone**, is a
   candidate; one still running is not, one whose directory has been deleted is not, one
   nothing has touched for a week is not, and one that cannot be asked about is left alone,
   the same rule the transcript lock follows. Retirement is decided ahead of the probes,
   which is why nothing was probed for it.
5. Exact-cwd records come first and then the most recent. Most of the engineer's terminals
   share a directory, so cwd is a preference rather than a filter: a restored terminal
   takes a waiting conversation whatever directory it belongs to, rather than starting
   fresh and leaving one stranded.
   **Newest-first, not FIFO**, because the pile holds more than the terminals do. Only a
   `CONVERSATION_OVER_REASONS` reason closes a record, so a week's signal-killed sessions
   and `/resume` departures are all in there. FIFO handed each terminal the stalest thing
   in it: an engineer with ten tabs got ten conversations from days ago while the ten they
   actually had open sat unclaimed behind them, which is the opposite of giving back what
   was open. Newest-first hands back what was live most recently, overwhelmingly what was
   on screen, and lets the stale ones sink to the bottom where `RESTORE_WINDOW_MS`
   eventually retires them. It reads *last activity* only because `at` is refreshed as a
   conversation is driven — see the `ACTIVITY_REFRESH_MS` rule above; without that this is
   newest-*registration*-first, which ranks a one-question session over a day's work. The
   session-id tiebreak stays, so two terminals still walk the candidates in the same order.
   `hair --list` prints the same array `claimFirst` walks, and it has to: the top line is
   the conversation the bare form is about to take, which is what makes the list worth
   eyeballing.
6. `hair --list` stops here: `resolveNames` reads every candidate's name and
   `describeCandidate` prints one line each. The bare form resolves nothing yet — the name is
   not an input to the ordering, so there is nothing to settle before the claim.
7. `claimFirst` walks the candidates and takes the first it wins with `O_EXCL`. Then, and only
   then, `resolveName` reads **that one** record's name from the conversation's own transcript
   — found by the recorded slug or by scanning the project directories for
   `<session-id>.jsonl`, taking the last `custom-title` record over the last `ai-title` one,
   and falling back to the name the record holds only when there is no transcript to read.
   That is the **only** place a title is read: the hook does not, deliberately. One scan per
   restore, not one per candidate, which after a reboot is the difference between a pass and a
   pass per waiting conversation.
8. `seams.chdir` moves to the record's own directory, then `launch()` runs with
   `["-r", id, "--name", <the resolved name>, ...rest]`. `--name` is how the tab title comes
   back: Claude Code sets the title from it as the TUI mounts. The resumed session's own hook
   reads it from there too, so the registry's copy stays in step — though that copy is only
   ever the fallback. Nothing here writes a title itself.

The other half is the hook. `sessionRegistryHooks` puts `UserPromptSubmit` and
`SessionEnd` entries into the settings hai already passes as its single `--settings`, so
nobody hand-wires `.claude/settings.json`. Two things that had to be dealt with for that:

- `buildSettings` returned `Record<string, string>` and now returns `Settings`, the hooks
  being a nested object.
- `mergeSettings` was a shallow spread, so a user-supplied `--settings` carrying any
  `hooks` key of its own would have silently discarded the registration hooks — and the
  only symptom would have been `hair` finding nothing to restore weeks later. `hooks` now
  merges per event with ours first, and a shape that cannot be merged warns the way
  `API_KEY_HELPER_OVERRIDE_WARNING` does.

`hair` is resolved differently per path, and this is where the feature stops short.
In-place, the command is this interpreter and `binPath("hair")` — absolute, realpath'd, no
PATH lookup and no execute bit. In container mode hai's install is a host path the
container cannot see, so it falls back to `hair` on PATH inside the image — and
`cft-workspace/devcontainer` installs no `@hmcts-cft/hai-cli`, so **on a bare host nothing
reaches `sessions.jsonl` at all today**. That is survivable (a failing hook changes nothing
about the session) but it means the registry currently only fills up for sessions started
with `hai` *inside* a container that already has hai on its PATH — the devcontainer case.
Installing hai into that image is a cft-workspace change, not one for this repo.

Claude Code runs a hook command through `/bin/sh -c` — measured, the hook's parent process
is `/bin/sh -c <command>` — so `hookCommand` shell-quotes what it emits. That is not a
breach of "never a shell": hai runs no shell, it hands a string to one it does not control,
and the quoting is what stops a session name with a space in it being read as more argv.

### Measured on Claude Code 2.1.304

| Session | `CLAUDE_CODE_SESSION_ATTENDED` | `CLAUDE_CODE_ENTRYPOINT` | fires `UserPromptSubmit` |
|---|---|---|---|
| interactive | `1` | `cli` | yes |
| `claude -p` | `0` | `sdk-cli` | yes |
| `claude --bg` | `0` | `cli` | yes |

`UserPromptSubmit` carries `session_id`, `transcript_path`, `cwd`, `prompt_id`,
`permission_mode`, `hook_event_name` and `prompt`. `SessionEnd` carries the same less
`permission_mode` and `prompt`, plus `reason`. Neither carries the session's `-n/--name`,
which is why hai reads it off the argv and puts it on the hook's command line. `CLAUDE_PID`
in the hook environment is the owning `claude` process, not the hook's own, and is what the
registry records. `transcript_path` is `<…>/projects/<slug>/<session-id>.jsonl` and is the
only authoritative statement of which project directory the conversation is filed under; the
registry records the slug out of it rather than deriving one from `cwd`, and the file it
names is where the conversation's name is read from — the `ai-title` and `custom-title`
records in the rules above.

#### The terminal tab title: `claude` writes it, hai does not

**The harness matters more than the command.** A capture in which the TUI never mounts shows
no title at startup, and two claims were wrong because of exactly that. `TERM` and
`TERM_PROGRAM` have to be set and the session has to be under a pty:

```bash
TERM=xterm-256color TERM_PROGRAM=vscode script -qc 'claude -n ZZNAMEPROBE' /dev/null > cap.bin
grep -abo $'\033]0;' cap.bin   # byte offsets of every OSC 0 in the stream
```

For `claude -n ZZNAMEPROBE`, in a 2990-byte capture:

| byte | sequence | when |
|---|---|---|
| 142 | `ESC]0;⏳ ZZNAMEPROBE` | at startup, as the TUI mounts |
| 2356 | `ESC]0;● ZZNAMEPROBE` | rewritten as the session's status changes |
| 2913 | `ESC]0;` | cleared on exit |

So **`-n/--name` sets the tab title**, Claude Code owns it for the life of the session, and
it reasserts it as the status changes. The selector in the binary is
`terminalTitle: sessionTitle ?? aiSessionTitle ?? agentTitle ?? haikuTitle ?? "Claude Code"`,
with a `terminalTitleFromRename` setting beside it.

Two earlier entries in this file asserted the opposite — that Claude Code writes no title at
startup, and that `-n` persists and sets nothing — and both were artefacts of a capture
taken without those variables, where the only `OSC 0` was the clear-on-exit at the end of
the stream. An `OSC 0` written from outside before the handover is overwritten within about
a second. Nothing in hai writes a terminal title; passing `--name` is the whole mechanism.

`reason` is a closed enum of five, and this is the table the whole deregistration rule
turns on. The enum is both what the hooks reference documents
(<https://code.claude.com/docs/en/hooks>) and what the installed 2.1.304 binary validates
against — `grep -a -o '\["clear"[^]]*\]'` over
`.../@anthropic-ai/claude-code/bin/claude.exe` returns
`["clear","resume","logout","prompt_input_exit","other"]`, and a sixth,
`bypass_permissions_disabled`, was removed in 2.1.234 and is no longer in the binary at
all.

| `reason` | fired by | hai's verdict | why |
|---|---|---|---|
| `prompt_input_exit` | `/exit` | deregister | done with that id |
| `clear` | `/clear` | deregister | ends that id and opens a new one |
| `logout` | `/logout` | keep the entry | deliberate about credentials, not about the conversation, which stays resumable |
| `resume` | an interactive `/resume` switch | keep the entry | leaves a conversation rather than ending it |
| `other` | **`kill -TERM`**, a finished `-p` run, `claude stop` on a `--bg` one | keep the entry | a kill is the case the registry is *for*; the other two never register |

The row that matters is `other`, and it is the one measured late. Run
`claude --settings <a settings with a SessionEnd hook> -p 'write 400 words about rivers' &`
and then `kill -TERM <pid>`: the hook fires, with `"reason":"other"`. A kill is therefore
indistinguishable from a clean `-p` finish, so nothing in a `SessionEnd` payload says "this
session was terminated" — only the absence of a *done-with-this-id* reason does. Do not
restore "every reason deregisters" from first principles; that is the bug, and what it cost
was every ending that goes through a signal, which is every ordinary one: a SIGKILL or a
power cut left an entry open, and nothing else did.

Subagents do not register anything of their own: a subagent's work shows up as a
`UserPromptSubmit` on the **parent** session's id, with the prompt opening
`<agent-message from="...">`. Keying the upsert on the session id makes that a no-op, and
the same is true of `SessionStart` firing again on `clear` and `compact`.

## Docker Sandboxes mode (`sbx-hai`)

`sbx-hai` is the third backend: the same argv-forwarding contract and the same self-update,
with the session in an sbx microVM built from `hmctsprod.azurecr.io/cft-workspace/sbx:latest`
instead of a container hai starts. It is a port of cft-workspace's `scripts/sbx-claude`;
read that script before changing anything here, because most of this is its hard-won
behaviour:

- **`sbx` is host-only, so `sbx-hai` refuses inside a container.** `HAI_FORCE_HOST=1` is
  the escape hatch, as it is for container mode.
- **`sbx version --json` is the one command that answers without the daemon-version gate.**
  When the CLI and the running `sandboxd` disagree, sbx holds every command behind a stderr
  prompt it then waits on, so a piped or captured call hangs for good having printed
  nothing. `daemonMismatch` detects that and says to run `sbx daemon restart` — hai never
  runs it, because it stops every running sandbox, other sessions' included.
- **The create needs three host-wide settings put right first**: `kit.allowedSources` (sbx
  only pulls allow-listed kits and defaults to Docker Hub alone), `sandbox.disk.dockerVolume`
  raised to 40g (sbx's 10g default is overrun by the CFT images; read only at create time,
  and **only ever raised**), and the ACR pull token.
- **The registry secret goes in both scopes.** The host scope pulls the kit; the separate
  `--all-sandboxes` scope is what the sandbox's *own* Docker engine uses, and without it
  every hmctsprod pull inside fails with "authentication required". One
  `az acr login --expose-token` feeds both, on a `--password-stdin` stdin, and the token
  lasts about 3h so only the create refreshes it — a reattach refreshes neither.
- **Kit staleness is a warning, never a block, and has a known false positive.** A sandbox
  records the digest of the one architecture it pulled, so a difference from the tag's
  digest is only stale if the recorded digest is *not* a child of the published multi-arch
  index. Every path that cannot tell reports not stale.
- **The claude argv is not built here.** The kit's own launch script execs `hai` with the
  arguments after the `--`, so the route is resolved inside the sandbox and `sbx-hai`
  forwards those arguments and nothing else. (`.claude/run.sh` is being deleted from
  cft-workspace; the kit launcher no longer branches on which credential sbx bound.)
- **No credential and no route environment is forwarded.** sbx injects the Anthropic
  credential from its own secret store (`scripts/sbx-setup` puts it there), and the kit owns
  the Bedrock environment, so forwarding hai's would fight it. The route is still resolved
  on the host, but only to report which one would apply — and a host where nothing resolves
  must still be able to start a sandbox, so that resolution is best-effort.

Deliberately **not** ported from `scripts/sbx-claude`: the port watcher and its stale-port
repair, `--update`'s state snapshot/restore, the host `settings.json` denylist
(`CFT_HOST_CLAUDE_SETTINGS`), `--local` kit builds and `-p` publishes. There is also no
transcript lock: the shared `~/.claude/projects` means the same rule as the shell script —
do not run Claude on the host in the same checkout at the same time.

## Testing

`vitest`, co-located `*.test.ts`, Arrange-Act-Assert with `// Arrange` / `// Act` /
`// Assert` comments. Coverage is 90% over `src/**`, with a per-module 100% threshold on
the pure decision modules of the table above — the list is `PURE_DECISION_MODULES` in
`vitest.config.mts`. A test earns its place by catching a regression, not by moving the
number: do not add one over a seam that only assigns, or a row a function cannot tell
from the row above it. Fakes live in `src/__fixtures__/fake-seams.ts` and are excluded from
coverage and from the build. **Never `vi.mock` a node builtin** — that is what the seams
are for. `createFakeSeams` gives you a whole `Seams` with recording and scripting:

```ts
const seams = createFakeSeams({
  env: { HOME: "/home/dev" },
  files: { "/.dockerenv": "" },
  respond: (argv) => (argv[1] === "account" ? { stdout: "{}" } : undefined),
  fetch: async () => new Response("{}", { status: 404 })
});
```

`seams.lines` holds every logged line, `seams.out` every stdout write,
`seams.runner.calls` and `seams.runner.execCalls` every process launched, and `seams.exit`
throws a signal you read with `exitCodeOf`.
