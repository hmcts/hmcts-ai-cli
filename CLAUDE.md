# hmcts-ai-cli

`hai`, a transparent wrapper around the `claude` CLI. Read `README.md` first — it covers
the routes, the environment variables and the state directory. This file covers only the
things an agent working in this repo needs that the README does not say.

## Commands

```bash
yarn install
yarn lint            # biome check --error-on-warnings .
yarn lint:fix
yarn typecheck       # tsc --noEmit over src/ and *.mts
yarn test
yarn test:coverage   # 100% thresholds on src/**, excluding src/bin/**
yarn build           # tsc -p tsconfig.build.json -> dist/
```

## Hard rules

- **`hai` has no arguments of its own.** Never add a flag, a subcommand or an argument
  parser. Every argument is forwarded to `claude` verbatim. All configuration is
  `HAI_*` environment variables. `src/claude/args.test.ts` guards this.
- **`--settings` is the one deliberate exception, and it stays.** `claude`'s `--settings`
  is last-wins rather than merged, so passing it twice discards hai's own settings
  silently — on the gateway route that drops the `apiKeyHelper` and the session starts
  failing auth a few minutes in. `src/claude/user-settings.ts` therefore lifts a
  user-supplied `--settings` out of the forwarded argv, merges it over hai's with the
  user's keys winning, and emits exactly one. This is not a violation of the rule above
  to be reverted.
- **No credential is ever written to disk.** The caches in `src/auth/auth-cache.ts` and
  `src/update/self-update.ts` hold decisions, not secrets.
- **Every log line and error goes through `redact()`.** `createLogger` applies it, and
  `main` routes every thrown error through the logger. Do not write to stderr directly.
- **Only `src/system/runner.ts` imports `node:child_process`; only `src/system/fs.ts`
  imports `node:fs`; only `src/system/net.ts` imports `node:net`.** Enforced by Biome's
  `noRestrictedImports` with per-file overrides, and independently by
  `src/system/import-restrictions.test.ts`.
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
  the entrypoint exports and deletes each one. `buildDockerArgs` never reads `secretEnv` —
  it is in the context only so the test, parameterised over every route, has a real value
  to look for.
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
src/system/     the seams: Runner, Fs, Clock, Net, Env, HiddenInput, plus createSeams()
src/log/        redact() and the logger everything speaks through
src/az/         az CLI calls: token, account, checkMemberGroups, Key Vault
src/auth/       route resolution, the agent-hub client, credentials, the env to inject
src/net/        the VPN probe (informational only, never blocks)
src/claude/     the claude argv and settings
src/workspace/  cft-workspace detection and plugin-dir resolution
src/update/     the Azure Artifacts feed and the self-update
src/container/  container mode: the docker argv, mounts, DNS, ports, the port watch, lock, ACR, staging
src/sbx/        Docker Sandboxes mode: the sbx argv, the kit and the host settings it needs
src/launch.ts   `hai`'s orchestration; src/sbx-launch.ts is `sbx-hai`'s
src/main.ts     wraps either of them in error handling: main() and sbxMain()
src/bin/        two-line shims, excluded from coverage
runtime/        the shell the container runs, shipped in the package and staged at launch
```

Pure functions over gathered facts, with the I/O separated out, so the decisions are
table-testable:

| Pure | I/O that feeds it |
|---|---|
| `resolveRoute(signals)` | `gatherSignals` |
| `isInContainer(probe)` | `probeContainer` |
| `skipUpdateCheck(input)` | `maybeSelfUpdate` |
| `detectPackageManager(input)` | `maybeSelfUpdate` |
| `packumentUrl(feed, name)`, `latestFromPackument(body)` | `maybeSelfUpdate` |
| `extractUserSettings(argv)`, `mergeSettings(ours, theirs)` | `readUserSettings` |
| `resolvePluginDirs` is the exception — it reads the marketplace itself | — |
| `buildDockerArgs(ctx)` | `gatherContext` in `src/container/run.ts` |
| `selectDnsServers`, `parseResolvectl`, `parseNetif`, `parseNmcli` | `discoverDns` |
| `parseDevcontainer`, `defaultSpec`, `resolveMounts`, `hostPrepPaths` | `readSpec`, `prepareHost` |
| `resolvePorts`, `expandPorts`, `selectPorts`, `portClashMessage`, `publishArg`, `parseEphemeralLow`, `splitEphemeral` | `choosePorts`, `chooseFreePorts`, `readEphemeralLow` |
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
- **`hai-*` cache volumes, not the devcontainer's `cft-*` ones**, so a hai session and a
  devcontainer cannot fight over the same Gradle lock. `HAI_SHARE_CACHES=1` opts back in.
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
  clashed with whatever else the engineer was running, so `HAI_PORTS` now publishes nothing
  by default. Instead `src/container/port-watch.ts` polls
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
  **The pre-create sweep runs before `choosePorts` probes the host**, not after: a SIGKILLed
  session's sidecar is holding one of the numbers about to be probed, so probing first reports
  a create-time clash against hai's own corpse and drops a mapping the engineer asked for. A
  session that is still up owns its sidecars, so a reattach sweeps nothing.
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
  breaks XUI's sign-in redirect. Both the create-time list and the watcher go through
  `chooseFreePorts`, which is a bind probe on the host and nothing more: it does not know
  whether a candidate came from `HAI_PORTS` or from a listener that has just appeared. A
  port skipped stays skipped for the session rather than being retried every tick, and a
  listener bound to `127.0.0.1` inside is reported once as loopback-only with the "bind it
  to 0.0.0.0" hint, no sidecar being able to reach it.
- **`HAI_PORTS` and the watcher are additive.** `HAI_PORTS` is `docker run -p`, so it is the
  only thing that can have a port answering from the session's first instant — no poll
  delay, no sidecar — and `cft` still means the same 20. The watcher seeds its decided set
  with whatever was published at create time, so it never puts a sidecar in front of a
  mapping Docker already has (which could not bind that host port anyway). `HAI_PORTS=none`
  is the explicit form of the default; `HAI_NO_PORT_WATCH=1` turns the watcher off.
  `docker run` publishes all or nothing, so a create-time clash is still probed up front by
  `choosePorts` rather than failing the whole start — and the race between the probe and
  `docker run` cannot be closed, only reported, which is what `portClashMessage` does when
  the daemon refuses the bind anyway.

`HAI_FORCE_HOST=1` forces container mode — it overrides both the probe and
`HAI_FORCE_CONTAINER`, and it is the only way to exercise container mode from inside a
devcontainer, which otherwise detects itself and takes the in-place path.

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
- **The claude argv is not built here.** The kit's own launch script chooses between
  `claude --dangerously-skip-permissions` and `.claude/run.sh` depending on which credential
  sbx bound, so `sbx-hai` forwards the arguments after a `--` and nothing else.
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
`// Assert` comments. Fakes live in `src/__fixtures__/fake-seams.ts` and are excluded from
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
