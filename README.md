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

A route is one credential from one source, and `hai` says which one it took and who pays
for it on every launch:

| `HAI_ROUTE` | Credential | Where it comes from | Who pays |
|---|---|---|---|
| `agent-hub` | a long-lived Claude token | agent-hub (its `claude` credential) | that Claude licence, not HMCTS |
| `byol` | your Claude OAuth credential | `CLAUDE_CODE_OAUTH_TOKEN`, or the claude.ai login in `~/.claude` | your own licence, not HMCTS |
| `ai-gateway` | the APIM subscription key | a private Key Vault, so `az login` and the F5 VPN — or `HAI_GATEWAY_APIM_KEY` | HMCTS |
| `bedrock` | `AWS_BEARER_TOKEN_BEDROCK` | your environment, or pasted at a hidden prompt | HMCTS |

Setting `HAI_ROUTE` is a choice and `hai` obeys it: that one credential is fetched from
that one source, and if it cannot be had the launch fails saying so rather than quietly
using something else. Two of the four bill a personal Claude licence, which is why the
route and who pays for it are printed whether or not you asked for `HAI_VERBOSE`.

With `HAI_ROUTE` unset, `hai` works it out, in this order:

1. You are in the Bedrock developer group — `ai-gateway`, because HMCTS funds your
   capacity and the gateway is the route it manages: quotas, model allow-lists, content
   safety and per-service cost attribution. This is first, ahead of the Bedrock keys as
   well as every personal credential, so a key left in your environment or held on
   agent-hub no longer decides anything. If the gateway turns out to be unreachable the
   fallback is a Bedrock key — from your environment, agent-hub, or pasted — never your
   own subscription.
2. `AWS_BEARER_TOKEN_BEDROCK` is exported — `bedrock`.
3. agent-hub holds a Bedrock key for you — `bedrock`.
4. Your group membership could not be checked — a Bedrock key you paste, or a refusal
   naming `HAI_ROUTE=byol` if that is genuinely what you want. An unanswered question is
   not an answer of "not a member".
5. You are confirmed *not* in that group — `byol`, from `CLAUDE_CODE_OAUTH_TOKEN` or your
   claude.ai login.

`HAI_ROUTE=bedrock` is how a member goes to Bedrock directly, and it is obeyed like any
other named route.

`own-licence` and `gateway` were the old names for `byol` and `ai-gateway`. They are not
accepted as aliases: `hai` fails and names the replacement. `gateway` in particular had to
go, because cft-workspace's `AGENT_HUB_MODEL_ROUTE=gateway` means *Bedrock*.

## `hair`

A reboot ends every Claude Code session at once, and `claude --continue` keys only on the
directory, so it cannot tell apart the several sessions you had open in one repo. `hair`
("hai resume") handles that. Sessions record themselves in `~/.claude/sessions.jsonl` as
you use them and remove themselves when *you* end the conversation: `/exit` and `/clear`,
and nothing else. A crash, a reboot, closing the editor on a devcontainer, a `kill`,
`/logout`, switching away with `/resume` — all of those leave the entry in place, so a
conversation stops being offered only once you are done with that conversation. Entries
nothing has touched for a week are then dropped; that only stops `hair` offering them, and
`claude -r` still finds the conversation.

```bash
hair          # claim one interrupted conversation and resume it
hair --list   # show what is waiting, claiming nothing
```

Run it in each terminal you reopen and each gets a different conversation. It prefers one
last used in the directory you are in, and then the one you were working in most recently.
Anything else you pass is forwarded to `hai`, and if the arguments already name a
conversation — `hair -c`, `hair -r <id>` — nothing is claimed and `hair` is simply `hai`.

Before resuming, it moves to the directory the conversation was **opened** in, which is
usually not the one it ended up in: a session that `cd`s into a worktree is recorded against
the worktree, and resuming there means a "do you trust this folder" prompt every time and a
different `CLAUDE.md`, `.claude/settings.json` and set of hooks from the ones the
conversation ran under. The opening directory is the one Claude Code resolved all of those
from, so going back there is what makes a restored conversation pick up where it left off.
If that directory has since gone, it falls back to the last one the session was seen in.

`hair --list` shows the candidates in the order `hair` claims them, so its top line is the
one `hair` would take, and names the directory each one would resume in. A `(last here)` note
marks the ones that were last used in the directory you are standing in — those are the ones
sorted to the top, and it is the only thing separating them from a conversation that merely
happens to resume here.

A restored conversation comes back under its own name, which is also what Claude Code titles
the terminal tab from. `hair` passes the name on to `claude`, and reads it out of the
conversation's own transcript: the name you set with `/rename` if you set one, and otherwise
the name Claude Code had generated for it — so conversations you never renamed come back named
too, and one you renamed moments before losing it comes back under the new name.
`hair --list` shows the same name `hair` would use. Passing a name is also how a name is set,
so the first restore fixes it: a conversation you never renamed keeps the generated name it
had at that point even if Claude Code would word it differently today. `hair` writes
nothing to your terminal itself: the title is Claude Code's, set as the session starts and
cleared when it ends, and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` is how you turn it off.

A conversation is recorded on the first prompt you type, so `-p` runs and background jobs
never appear. The registry is written by hooks that run inside the session, so `hai` has to
be on the `PATH` wherever that is. Start `hai` from inside a devcontainer and it runs
`claude` in place, so it is. Start it on your own machine and it runs the session inside a
container built from the cft-workspace image, which installs `claude` but not `hai` — so
nothing is recorded there yet, and `hair` has nothing to offer you afterwards. Passing your
own `--settings` with a `hooks` key replaces those hooks, and `hai` says so when it happens.

## `sbx-hai`

Runs the session in a Docker Sandboxes microVM built from the cft-workspace sbx kit,
instead of a container `hai` starts itself. Argument forwarding and self-update are the
same as `hai`.

It is host-only and needs `sbx` installed. Run `scripts/sbx-setup` in cft-workspace once
first: `sbx` supplies the Anthropic credential from its own secret store, so `sbx-hai`
reports which route would apply but injects nothing. It has not yet been exercised against
a real `sbx`, so treat it as unproven.

## Environment variables

| Variable | Effect |
|---|---|
| `HAI_ROUTE` | `agent-hub` \| `byol` \| `ai-gateway` \| `bedrock`; see [Routes](#routes). Obeyed as typed, with no fallbacks |
| `HAI_DRY_RUN=1` | print the `claude` invocation that would run, then exit 0 |
| `HAI_VERBOSE=1` | explain what was detected and why |
| `HAI_OFFLINE=1` | skips the lookups that need the network: no Graph, no agent-hub, no registry. Your local `az` identity and the cached group answer are still read, so a group membership confirmed earlier in the day still decides the route |
| `HAI_NO_UPDATE=1` | skip the self-update check |
| `HAI_FORCE_CONTAINER=1` | treat this as a container even if nothing was detected |
| `HAI_GATEWAY_APIM_SECRET` | override the Key Vault secret name for the APIM key |
| `HAI_GATEWAY_APIM_KEY` | the APIM subscription key itself, used instead of the Key Vault read; an empty value counts as unset |

`HAI_IN_CONTAINER`, `HAI_ENV_READY`, `HAI_UPDATED` and `HAI_API_KEY_HELPER` are set by
`hai` itself. The first two go only to the container `hai` starts, so a nested `hai` there
need not resolve the route again; the third stops a broken release looping after an update.

`HAI_API_KEY_HELPER` is the exception: it is set for the session to read rather than for
`hai`, and only on the `ai-gateway` route, where it holds the path of the `apiKeyHelper`
that mints your token. `claude --settings` keeps only the last one it is given, so anything
inside a session that spawns its own `claude` — dtsse-agent-hub's stop-worker summariser is
the one that does — has to name the helper in its own settings, and the gateway's base URL
and APIM header it inherits are no use without it. Every other route *clears* the variable,
because those routes have no helper and the gateway's would be the wrong credential for
them. Read it if it is there and carry on as before if it is not: a session may be running
a `hai` older than this.

## Developing

```bash
yarn install
yarn lint
yarn typecheck
yarn test
yarn test:coverage   # 90% over src/**, 100% on the pure decision modules
yarn build           # tsc to dist/
```
