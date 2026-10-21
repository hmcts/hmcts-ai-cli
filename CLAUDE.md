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
  imports `node:fs`.** Enforced by Biome's `noRestrictedImports` with per-file overrides,
  and independently by `src/system/import-restrictions.test.ts`.
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
src/launch.ts   the orchestration; src/main.ts wraps it in error handling
src/bin/        two-line shims, excluded from coverage
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

Keep that split when adding anything: the decision goes in a pure function with a
table-driven test, the probing goes next to it.

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

## Faithfulness to run.sh

The bedrock environment, the prompt behaviour, the `can_prompt` rule and `add_plugin_dirs`
are reimplementations of cft-workspace's `.claude/run.sh`, and the gateway environment of
`apps/cath/cath-service/.claude/run.sh` + `token.sh` + `cnp.settings.json`. Changing any
of them means re-reading the original first.

One deliberate difference: the gateway route also sets the three
`ANTHROPIC_DEFAULT_*_MODEL` variables (cath's `run.sh` does, the brief's env block did
not) — without them `claude` asks the gateway for `us.anthropic.*` model ids.

## Out of scope for now

Container mode — `docker run`, mounts, DNS, ports, the secrets tmpfs — is not built.
`launch` detects that it is not already containerised and says so. `sbx-hai` is a
placeholder that exits 2. Do not start on either without checking what the current slice
is meant to cover.
