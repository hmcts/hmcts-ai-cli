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
deliberate choice rather than an accident. Under `HAI_OFFLINE=1` nothing is looked up at
all, so membership is never confirmed and the refusal names `HAI_ROUTE=own-licence` rather
than the `az login` the flag opted out of.

The group answer is cached for 12 hours against your signed-in `az` identity, in
`auth.json` in the state directory (`$XDG_STATE_HOME/hai`, or `~/.local/state/hai`).
Reading it back does not extend it, so the check really does happen again twice a day;
delete the file if you have just been added to the group and want it sooner.

## Picking your sessions back up after a reboot

If you run several Claude Code sessions in several terminals, a reboot ends all of them at
once, and the usual ways back are no help:

- `claude --continue` keys only on the directory, so for the half-dozen sessions you had
  open in the same repo it cannot tell which one you meant.
- `claude -r <id>` on a session that is still running forks a *copy* of the conversation
  rather than attaching to it, so guessing is worse than not trying.
- `tmux` does not survive it either, because the reboot stops the devcontainer the
  sessions were running in.

`hair` ("hai resume") fixes that. A session records itself in a registry as you drive it,
and removes itself when you exit. A reboot cannot remove anything, so anything still
marked open is a conversation that was taken from you — and that is what `hair` hands
back, one per terminal:

```bash
hair          # claim one of the interrupted conversations and resume it
hair --list   # see what is waiting, without claiming any of it
```

Run `hair` in each terminal you reopen and each gets a different conversation. It prefers
one that belongs to the directory you are in, falls back to the oldest waiting one
whatever directory that is, and moves to that conversation's own directory before
resuming — resume-by-id is not directory-scoped, so resuming from the wrong place would
quietly rebind the session's project settings, hooks and `CLAUDE.md`. When nothing is
waiting it just starts a fresh session.

`hair` does not run `claude` itself — it works out which conversation is yours and then
hands over to `hai`, so the route, the credentials, the container and the self-update are
all the same as any other session.

Everything after `hair` is forwarded, so `hair --model opus` works like `hai --model opus`.
If the arguments already name a conversation — `hair -r <id>`, `hair -c` — nothing is
claimed and `hair` is simply `hai` with the arguments as typed.

### Where this works today

The registry is written by hooks that run **inside the session**, so it needs `hai` to be
installed where the session runs:

| How you start sessions | Recorded? |
|---|---|
| `hai` inside a devcontainer or any other container (the in-place path) | yes |
| `hai` on a bare host, which starts a container for the session | **no, not yet** |
| `sbx-hai` | no |

On the bare-host path `hai` runs the session inside
`hmctsprod.azurecr.io/cft-workspace/devcontainer`, which does not install
`@hmcts-cft/hai-cli`, so the hook has no `hair` to run and nothing reaches
`sessions.jsonl`. Installing hai into that image is a change to cft-workspace rather than
to this repo. Until then, `hair` is for engineers whose sessions run in a container that
already has hai on its `PATH` — which is the devcontainer case, and the one the story
above describes.

A hook that cannot be run changes nothing else: Claude Code ignores the failure, and the
session's output and exit status are untouched.

### The registry

`~/.claude/sessions.jsonl`, one JSON object per line: the session id, its directory, its
`-n/--name` if it has one, whether it is open, when it was last seen, the process that
owned it and where that process lived. `hai` installs the hooks that maintain it, so there
is nothing to put in `.claude/settings.json` yourself.

A conversation is recorded on the first prompt **you** type into it, not when it starts.
That is deliberate: a registry that recorded every session start would fill up with
subagent runs, `claude -p` scripts and background jobs, and after a reboot they would all
look like conversations waiting for you. Only a session someone is sitting in front of is
recorded, so `-p` runs and `--bg` jobs never appear.

A conversation is never offered if it is still running, if its directory has since been
deleted, or if `hair` cannot work out whether the process that owned it is alive — it
would rather hand you nothing than a copy of a session you already have open. Run
`hair --list` with `HAI_VERBOSE=1` and it says what it passed over and why.

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
