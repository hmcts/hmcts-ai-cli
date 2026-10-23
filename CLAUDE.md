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
- **Deregistration is on `SessionEnd`, and the asymmetry is the whole mechanism.** A clean
  exit removes its own entry; a reboot cannot. "Still marked open" *is* the crash signal.
  Every reason deregisters, `clear` included — `/clear` ends that id and starts a new one,
  so the old id is not a conversation to hand anyone.
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
- **The credential fetch honours the resolved source rather than deciding again.**
  `resolveBedrockKey` takes the resolution's `credentialSource` and reads agent-hub only
  when that source *is* `agent-hub`. The asymmetry is the point: on the unset path a
  hub-stored key is the **signal** that chose the bedrock route (`hasStoredBedrockKey`), so
  reading the hub there is not a fallback, it is the reason we are there — while a named
  `HAI_ROUTE=bedrock` is the environment or a paste, full stop. Deciding twice meant a named
  route silently reached the hub *and* that the launch line said `prompt` for a key that had
  come off the hub. A hub that failed during `gatherSignals` is therefore no longer re-asked
  here; it decides nothing either way and a key can still be pasted.
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
  `sps-ai-kv-sbox`, no `gateway-token.sh` and nothing through `logger.say`. The note is one
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
  the entrypoint exports and deletes each one. `ContainerContext` holds only the open half,
  so no argv builder can reach a secret even by mistake; the secret half is `LaunchContext`'s
  and only `deliverSecrets` sees it.
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
src/hair/       `hair`: the session registry, the restore candidates, the claim, the hook
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
| `parseRegistry`, `parseRecord`, `compacted`, `registryPath`, `claimPath` | `readRegistry`, `appendRecord`, `compactRegistry` |
| `restoreDecision`, `restoreCandidates`, `describeCandidate`, `livenessPlan` | `probeLiveness`, `probeDirs` |
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
   line, which is how ten sessions record themselves with no lock, and a deregistration is
   a tombstone appended after it. `compactRegistry` rewrites it once it is long — the one
   operation that can lose a concurrent append, which is why it waits for 500 lines.
3. `probeLiveness` works out per record how its pid can be asked about at all
   (`livenessPlan`) and then asks — `pidAlive` in the same namespace, `containerRunning`
   across one, nothing when the two cannot be compared. Only the open records: a
   tombstone's answer is thrown away, and one sequential `ps` per line adds up when
   compaction only kicks in at 500. `probeDirs` checks each distinct directory once.
4. `restoreCandidates` turns all of that into the ordered list. An open record whose
   directory is still there and whose process is **gone** is a candidate; one still
   running is not, one whose directory has been deleted is not, and one that cannot be
   asked about is left alone, the same rule the transcript lock follows.
5. Exact-cwd records come first and then FIFO. Most of the engineer's terminals share a
   directory, so cwd is a preference rather than a filter: a restored terminal takes the
   oldest waiting conversation whatever directory it belongs to, rather than starting
   fresh and leaving one stranded.
6. `claimFirst` walks the candidates and takes the first it wins with `O_EXCL`, then
   `seams.chdir` moves to the record's own directory, then `launch()` runs with
   `["-r", id, "--name", <the record's name>, ...rest]` — the name goes back on the argv
   because that is where the resumed session's own hook reads it from, and without it a
   session started as `hai -n pcs` comes back nameless and reads as "(unnamed)" in every
   later `hair --list`.

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
`permission_mode` and `prompt`, plus `reason`: `prompt_input_exit` for `/exit`, `clear`
for `/clear`, `other` for a finished `-p` run and for `claude stop` on a background one.
Neither carries the session's `-n/--name`, which is why hai reads it off the argv and puts
it on the hook's command line. `CLAUDE_PID` in the hook environment is the owning `claude`
process, not the hook's own, and is what the registry records.

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
