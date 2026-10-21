# hai — HMCTS AI CLI

`hai` runs [Claude Code](https://docs.claude.com/en/docs/claude-code) with the model route
and credentials an HMCTS engineer should be using. It works out which route applies, builds
the environment for it, and then runs `claude`.

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

There are no subcommands, because `claude doctor`, `claude update`, `claude config` and
`claude mcp` already exist and any name `hai` took would shadow one. Everything is
configured through `HAI_*` environment variables instead.

## Install

```bash
npm config set @hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/
npm i -g @hmcts-cft/hai-cli
```

`hai` is published to the HMCTS
[hmcts-lib](https://dev.azure.com/hmcts/Artifacts/_artifacts/feed/hmcts-lib) Azure
Artifacts feed rather than to npmjs.org. Reads from that feed are anonymous, so npm only
has to be told where to look.

## What it does

- Forwards your argv to `claude` unchanged.
- Resolves which model route and credentials to use, and builds the environment for it.
  `HAI_VERBOSE=1` explains what it detected and why; `HAI_DRY_RUN=1` prints the `claude`
  invocation it would run and stops.
- Fetches the AI Gateway credential and writes the `claude` settings that keep it
  refreshed, on the gateway route.
- Keeps itself up to date: it reads the feed at most once every six hours and, when there
  is something newer, installs it with `npm install -g` and re-execs with your argv as
  typed. A failed check is silent unless `HAI_VERBOSE=1` and never blocks a launch. An
  unwritable install prefix prints the command for you to run rather than reaching for
  `sudo`, and an `npx` run never updates anything. `HAI_NO_UPDATE=1` turns it off.
- Keeps credentials out of files and out of your terminal. Nothing secret is written to
  disk, and every log line and error message passes through a redactor first.

## It has to be run inside a devcontainer or sandbox

Right now `hai` only runs when it is already inside a container — a devcontainer, a
Codespace, or a sandbox session. On a bare host it says so and stops. If you know you are
containerised but nothing was detected, `HAI_FORCE_CONTAINER=1` gets you going.

## The AI Gateway route

`HAI_ROUTE=gateway` is the supported route. It goes through the HMCTS AI Gateway and needs
`az login` **and the F5 VPN** — the APIM subscription key lives in a private Key Vault
(`sps-ai-kv-sbox`), and that lookup is the only hard VPN dependency in the whole CLI. `hai`
generates an `apiKeyHelper` script and a settings file under its state directory and points
`claude` at them.

The APIM subscription is rate-limited to **30 requests/minute and 1000/day, shared across
everyone using that key**, so a busy session can exhaust it. `hai` says so when it picks
this route.

`HAI_ROUTE=own-licence` uses your own Claude licence instead, and is what `hai` picks up by
itself if this machine has a live claude.ai login. On macOS it looks in the login keychain
when `~/.claude/.credentials.json` is not there; if neither works, run `claude setup-token`
once and export the result as `CLAUDE_CODE_OAUTH_TOKEN`.

## Environment variables

| Variable | Effect |
|---|---|
| `HAI_ROUTE` | `gateway` \| `own-licence`; chooses the route instead of letting `hai` work it out |
| `HAI_DRY_RUN=1` | print the `claude` invocation that would run, then exit 0 |
| `HAI_VERBOSE=1` | explain what was detected and why |
| `HAI_OFFLINE=1` | environment and cache only; no lookups and no registry |
| `HAI_NO_UPDATE=1` | skip the self-update check |
| `HAI_FORCE_CONTAINER=1` | treat this as a container even if nothing was detected |
| `HAI_GATEWAY_APIM_SECRET` | override the Key Vault secret name for the APIM key |

`HAI_IN_CONTAINER`, `HAI_ENV_READY` and `HAI_UPDATED` are set by `hai` itself: the first
two let a nested `hai` skip route resolution it has already paid for, and the last stops a
broken release looping after an update.

## State

`${XDG_STATE_HOME:-~/.local/state}/hai/`, mode `0700`:

| File | What |
|---|---|
| `auth.json` | the resolved route, 12h TTL, mode `0600` |
| `update.json` | the latest published version, 6h TTL |
| `gateway-token.sh` | generated `apiKeyHelper`, mode `0700` |
| `settings.json` | generated `claude` settings for the gateway route |

**No credential is ever written to disk.** Keys live in the process environment for the
life of the session and nowhere else.

## Developing

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn test:coverage   # 100% thresholds on src/**, excluding src/bin/**
yarn build           # tsc to dist/
```
