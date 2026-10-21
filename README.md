# hai — HMCTS AI CLI

`hai` is a wrapper around [Claude Code](https://docs.claude.com/en/docs/claude-code). It
works out which model route and credentials you should be using, builds the environment
for it, and then runs `claude`.

It is a **transparent wrapper: it has no arguments of its own.** Everything you type after
`hai` reaches `claude` verbatim, including nothing at all:

```bash
hai                      # claude
hai -c                   # claude -c
hai -p 'summarise this'  # claude -p 'summarise this'
hai doctor               # claude doctor
hai mcp list             # claude mcp list
hai --help               # claude --help
```

The one exception is `--settings`. `claude` takes the last `--settings` it is given rather
than merging them, so your own would silently discard the one `hai` adds. `hai` reads yours
— inline JSON or a path — merges it over its own with your keys winning, and passes a
single `--settings`. Overriding `apiKeyHelper` on the gateway route works, but `hai` warns
you, because that is what keeps your token refreshed. Anything after a bare `--` is prompt
text to `claude`, not a flag, so `hai -- --settings x` is left exactly as you typed it.

There are no subcommands, because `claude doctor`, `claude update`, `claude config` and
`claude mcp` already exist and any name `hai` took would shadow one. Everything is
configured through `HAI_*` environment variables instead.

## Install

`hai` is published to the HMCTS
[hmcts-lib](https://dev.azure.com/hmcts/Artifacts/_artifacts/feed/hmcts-lib) Azure
Artifacts feed rather than to npmjs.org. **Reads from that feed are anonymous**, so no
token, PAT or `.npmrc` is needed to install it — npm only has to be told where to look.
Point the scope at the feed once:

```bash
npm config set @hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/
npm install -g @hmcts-cft/hai-cli
```

Or, if you would rather not change your npm config, name the registry on the command:

```bash
npm install -g @hmcts-cft/hai-cli --registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/
```

`hai` keeps itself up to date: it reads the feed at most once every six hours and, when
there is something newer, installs it with `npm install -g` passing the same `--registry` —
so the update needs no credential either. It then re-execs with your argv as typed. An
`npx` run never updates anything, and an unwritable install prefix prints the command for
you to run rather than reaching for `sudo`. A failed check is silent unless
`HAI_VERBOSE=1` and never blocks a launch. `HAI_NO_UPDATE=1` turns it off.

To depend on the package as a library in a yarn project, put the scope in `.yarnrc.yml`:

```yaml
npmScopes:
  hmcts-cft:
    npmRegistryServer: "https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/"
```

Some HMCTS repos add an `npmAuthIdent`/`npmAuthToken` under that scope, often from an
`exec:` script that shells out to `az`. That is only needed for *publishing*, or for a feed
that refuses anonymous reads; plain installs from hmcts-lib work without it.

## What this slice does

This is the first slice. It resolves the route and runs `claude` **only when it is already
inside a container or sandbox** — a devcontainer, a Codespace, or a cft-workspace `sbx`
session. Run it on a bare host and it says so and stops; building and entering the
cft-workspace container is the next slice. `sbx-hai` is a placeholder that exits 2.

## Routes

Three routes, resolved by this table. First match wins.

| # | Signal | How it is detected | Route |
|---|--------|--------------------|-------|
| 1 | `HAI_ROUTE` is set | — | as named |
| 2 | `AWS_BEARER_TOKEN_BEDROCK` is set | environment | `bedrock`, key from the environment |
| 3 | `CLAUDE_CODE_OAUTH_TOKEN` is set | environment | `own-licence` |
| 4 | agent-hub holds a Bedrock key for you | HTTP GET to agent-hub | `bedrock` |
| 5 | this machine has a live claude.ai login | `~/.claude/.credentials.json`, or the macOS login keychain | `own-licence`, nothing injected |
| 6 | you are in the Bedrock developer group but no key is stored | Graph `checkMemberGroups` | `bedrock`, prompts for a key and saves it to agent-hub |
| 7 | none of the above | — | fails, listing all three remedies |

Group membership never blocks anything. It only decides whether the "no key" message asks
you to paste one or to get group membership first. How a Bedrock key is issued is
deliberately not documented here — ask in the DTSSE channel.

### bedrock

The default. Sets `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`
and the three `ANTHROPIC_DEFAULT_*_MODEL` variables. Anything you have already exported
wins, so `AWS_REGION=eu-west-1 hai` does what it looks like.

### gateway

`HAI_ROUTE=gateway` goes through the HMCTS AI Gateway instead of Bedrock directly. It
needs `az login` **and the F5 VPN** — the APIM subscription key lives in a private Key
Vault (`sps-ai-kv-sbox`), and that lookup is the only hard VPN dependency in the whole
CLI. `hai` generates an `apiKeyHelper` script and a settings file under its state
directory and points `claude` at them.

The APIM subscription is rate-limited to **30 requests/minute and 1000/day, shared across
everyone using that key**, so a busy session can exhaust it. `hai` says so when it picks
this route.

### own-licence

Your own Claude licence. `hai` sets no Bedrock variables at all — they would override the
OAuth credential. On macOS, if `~/.claude/.credentials.json` is not there, `hai` looks in
the login keychain; if that fails too, run `claude setup-token` once and export the result
as `CLAUDE_CODE_OAUTH_TOKEN`.

## cft-workspace

When `hai` finds a `workspace.yaml` with a `repos:` key by walking up from the current
directory, it builds the same `claude` argv that cft-workspace's `.claude/run.sh` builds:
`--settings`, `--dangerously-skip-permissions`, and one `--plugin-dir` per name in
`AGENT_HUB_PLUGINS`, resolved through the workspace marketplace. A name that is missing
from the marketplace, or whose directory has no plugin manifest, is skipped rather than
treated as fatal.

`HAI_PERMISSIONS=ask` drops `--dangerously-skip-permissions`.

## Environment variables

| Variable | Effect |
|---|---|
| `HAI_ROUTE` | `bedrock` \| `gateway` \| `own-licence`; overrides the whole table |
| `HAI_PERMISSIONS` | `ask` drops `--dangerously-skip-permissions` |
| `HAI_DRY_RUN=1` | print the `claude` invocation that would run, then exit 0 |
| `HAI_VERBOSE=1` | explain what was detected and why |
| `HAI_OFFLINE=1` | environment and cache only; no agent-hub, no Graph, no registry |
| `HAI_NO_UPDATE=1` | skip the self-update check |
| `HAI_UPDATED=1` | set by `hai` on the re-exec after an update; stops a broken release looping |
| `HAI_FORCE_CONTAINER=1` | treat this as a container even if nothing was detected |
| `HAI_BEDROCK_GROUP_ID` | override the Entra group checked for Bedrock access |
| `HAI_GATEWAY_APIM_SECRET` | override the Key Vault secret name for the APIM key |
| `AGENT_HUB_URL`, `AGENT_HUB_SCOPE` | override the agent-hub endpoint and token scope |
| `AGENT_HUB_PLUGINS` | comma-separated workspace plugin names to load |

`HAI_IN_CONTAINER`, `HAI_ENV_READY` and `HAI_UPDATED` are set by `hai` itself. A nested
`hai` that sees both `HAI_IN_CONTAINER=1` and `HAI_ENV_READY=1` skips route resolution
entirely, so nesting costs no round trips.

## State

`${XDG_STATE_HOME:-~/.local/state}/hai/`, mode `0700`:

| File | What |
|---|---|
| `auth.json` | resolved route and group membership, 12h TTL, mode `0600` |
| `update.json` | the latest published version, 6h TTL |
| `gateway-token.sh` | generated `apiKeyHelper`, mode `0700` |
| `settings.json` | generated `--settings` for the gateway route |

**No credential is ever written to disk.** Keys live in the process environment for the
life of the session and nowhere else. Every log line and error message passes through a
redactor first.

## Developing

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn test:coverage   # 100% thresholds on src/**, excluding src/bin/**
yarn build           # tsc to dist/
```

Conventions follow the DTSSE house style: yarn 4, Biome rather than ESLint, ESM with `.js`
extensions on relative imports, `nodenext` resolution, pinned dependency versions,
co-located `*.test.ts`, and functional style.

Every side effect goes through a seam in `src/system/` — `Runner`, `Fs`, `Clock`, `Net`,
`Env`, `HiddenInput` — so tests use fakes and never mock a node builtin. Biome's
`noRestrictedImports` keeps `node:child_process` inside `src/system/runner.ts` and
`node:fs` inside `src/system/fs.ts`, and `src/system/import-restrictions.test.ts` checks
the same thing independently.

## Releasing

Every push to `master` publishes. `.github/workflows/release.yml` runs the same gates as
CI, bumps the patch version with `npm version patch`, publishes to the hmcts-lib feed, then
commits the bumped `package.json` back to `master` and pushes a `v<version>` tag. There is
no release PR and no Conventional Commits requirement; the version number carries no
meaning beyond "later".

That push-back means **`master` has to be unprotected**, or the protection rule has to
allow `github-actions[bot]` to push to it — otherwise the publish succeeds and the
version-bump push fails, and the next push publishes the same version again. The bump
commit cannot retrigger the workflow, because pushes made with `GITHUB_TOKEN` do not
trigger workflows; it also carries `[skip ci]`.

The publish needs the org-level secrets `AZURE_DEVOPS_ARTIFACT_USERNAME` and
`AZURE_DEVOPS_ARTIFACT_TOKEN` (a PAT with Packaging (Read & Write) on hmcts-lib) — the same
pair the HMCTS Gradle publish workflows use.
