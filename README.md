# hai — HMCTS AI CLI

`hai` runs [Claude Code](https://docs.claude.com/en/docs/claude-code) with the model route
and credentials an HMCTS engineer should be using. It works out which route applies, builds
the environment for it, and then runs `claude` inside a sandbox.

It is a **transparent wrapper: it has no arguments of its own.** Everything you type after
`hai` reaches `claude` verbatim, including nothing at all:

```bash
hai                      # claude
hai -p 'summarise this'  # claude -p 'summarise this'
hai --help               # claude --help
```

## Install

```bash
npm i -g @hmcts-cft/hai-cli --registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/
```

## What it does

- We either use the HMCTS Claude licenses or BYOL (Bring Your Own License) and configure the Claude models accordingly
- Run inside a container, isolating the agent from your host. The container has standard HMCTS tooling:
  - Java / sdkman
  - Node.js / nvm
  - kubectl
  - az cli
  - gh cli
  - many others
- Auto-updates the CLI and the docker image
- Keeps credentials out of files and out of your terminal. Nothing secret is written to disk, and every log line and error message passes through a redactor first.

## The AI Gateway route

`HAI_ROUTE=gateway` is the supported route. It goes through the HMCTS AI Gateway and needs
`az login` **and the F5 VPN** — the APIM subscription key lives in a private Key Vault
(`sps-ai-kv-sbox`), and that lookup is the only hard VPN dependency in the whole CLI. `hai`
generates an `apiKeyHelper` script and a settings file under its state directory and points
`claude` at them.

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

## Developing

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn test:coverage   # 100% thresholds on src/**, excluding src/bin/**
yarn build           # tsc to dist/
```
