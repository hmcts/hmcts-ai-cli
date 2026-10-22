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

## Routes

`hai` runs `claude` on one of three routes and builds the environment for it:

| Route | Credential |
|---|---|
| `bedrock` | an Amazon Bedrock API key, from `AWS_BEARER_TOKEN_BEDROCK`, from agent-hub, or pasted at a hidden prompt |
| `gateway` | the HMCTS AI Gateway, with an APIM subscription key read from Key Vault — needs `az login` and the F5 VPN |
| `own-licence` | your own Claude licence, via `CLAUDE_CODE_OAUTH_TOKEN` or a claude.ai login on this machine |

It works through the following order and takes the first match:

1. `HAI_ROUTE` names a route — that route is used, with the one exception below.
2. `AWS_BEARER_TOKEN_BEDROCK` is set — `bedrock`.
3. agent-hub holds a Bedrock API key for you — `bedrock`.
4. You are in the DTSSE AI Gateway Bedrock Developer group — `gateway`.
5. You are in that group and the gateway's key cannot be read — `bedrock`, pasting a key.
6. You are confirmed *not* in that group — `own-licence`, from `CLAUDE_CODE_OAUTH_TOKEN` or your claude.ai login.
7. Otherwise `hai` stops and says what to do about it.

### Your own subscription is never billed for HMCTS work

If you are in the Bedrock developer group then HMCTS funds your Claude usage, so `hai` will
not fall back to your personal claude.ai subscription: not through a claude.ai login on the
machine, not through an exported `CLAUDE_CODE_OAUTH_TOKEN`, and not through
`HAI_ROUTE=own-licence`, which is refused with an explanation. Where the gateway cannot be
reached the fallback is a Bedrock key you paste, and with no terminal to paste into `hai`
fails rather than spend your own allowance. Personal spend is the one kind nobody sees, so
it is never chosen on your behalf.

Where your membership cannot be confirmed at all — no `az` session, no VPN, or Graph
refuses the call — `hai` does not guess. It stops and says membership could not be
confirmed. `HAI_ROUTE=own-licence` is accepted in that case, because typing it is a
deliberate choice rather than an accident.

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
