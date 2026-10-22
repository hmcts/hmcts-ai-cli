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

There is a second binary, `hair`, which does have arguments of its own — see
[Picking your sessions back up after a reboot](#picking-your-sessions-back-up-after-a-reboot).

## Install

```bash
npm i -g @hmcts-cft/hai-cli --registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/
```

## What it does

- Use either the HMCTS Claude licenses or BYOL (Bring Your Own License) and configure the Claude models accordingly
- Run inside a container, isolating the agent from your host. The container has standard HMCTS tooling:
  - Java / sdkman
  - Node.js / nvm
  - kubectl
  - az cli
  - gh cli
  - many others
- Shares the CFT devcontainer's build caches, so a session starts with the Gradle, Maven, npm and yarn dependencies you already have. Avoid building the same repo in both at once: they share one Gradle lock.
- Adds no permission flags of its own. If you want permission prompts skipped, pass `--dangerously-skip-permissions` yourself and it reaches `claude` like any other argument.
- Auto-updates the CLI and the docker image
- Keeps credentials out of files and out of your terminal. Nothing secret is written to disk, and every log line and error message passes through a redactor first.

Note: If you are using a HMCTS license via the AI Gateway you will need to connect your VPN.

## Environment variables

| Variable | Effect |
|---|---|
| `HAI_ROUTE` | `bedrock` \| `gateway` \| `own-licence`; chooses the route instead of letting `hai` work it out |
| `HAI_DRY_RUN=1` | print the `claude` invocation that would run, then exit 0 |
| `HAI_VERBOSE=1` | explain what was detected and why |
| `HAI_OFFLINE=1` | environment only; no lookups and no registry |
| `HAI_NO_UPDATE=1` | skip the self-update check |
| `HAI_FORCE_CONTAINER=1` | treat this as a container even if nothing was detected |
| `HAI_GATEWAY_APIM_SECRET` | override the Key Vault secret name for the APIM key |

`HAI_IN_CONTAINER`, `HAI_ENV_READY` and `HAI_UPDATED` are set by `hai` itself. The first
two go only to the container `hai` starts, so a nested `hai` there need not resolve the
route again; the last stops a broken release looping after an update.

## Developing

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn test:coverage   # 90% over src/**, 100% on the pure decision modules
yarn build           # tsc to dist/
```
