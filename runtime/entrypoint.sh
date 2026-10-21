#!/usr/bin/env bash
# The interactive session, run as the image's user by `docker exec`. docker exec starts
# this under non-interactive bash, so no rc file has run: without sourcing nvm and sdkman
# first, claude, node, java and gradle are all absent.

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# shellcheck disable=SC1091
[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] && . "$HOME/.sdkman/bin/sdkman-init.sh"

set -uo pipefail

# ~/.gitconfig is not one of the mounts, so the host's identity is forwarded as these.
# Only fill what is unset, so anything already written to ~/.gitconfig wins and
# repo-local config keeps its usual precedence.
apply_git_identity() {
    command -v git >/dev/null 2>&1 || return 0
    local key value
    for key in name email; do
        case "$key" in
            name) value="${CFT_GIT_AUTHOR_NAME:-}" ;;
            email) value="${CFT_GIT_AUTHOR_EMAIL:-}" ;;
        esac
        [[ -n "$value" ]] || continue
        [[ -z "$(git config --global --get "user.$key" 2>/dev/null)" ]] || continue
        git config --global "user.$key" "$value" 2>/dev/null || true
    done
}
apply_git_identity || true

# The gateway route's apiKeyHelper. hai's host state directory is not this container's,
# so the script is installed here rather than path-translated; it holds no secret, only
# an `az account get-access-token` call against the mounted ~/.azure.
if [[ -f /opt/hai/gateway-token.sh ]]; then
    mkdir -p "$HOME/.local/state/hai"
    chmod 0700 "$HOME/.local/state/hai"
    install -m 0700 /opt/hai/gateway-token.sh "$HOME/.local/state/hai/gateway-token.sh" 2>/dev/null || true
fi

# Credentials arrive one per `docker exec -i` stdin and land on a tmpfs, never in the
# container's config: anything passed to docker run --env is readable afterwards with
# docker inspect and is written to disk with the container. Each is consumed once.
if [[ -n "${HAI_SECRETS_DIR:-}" && -d "${HAI_SECRETS_DIR:-}" ]]; then
    for f in "$HAI_SECRETS_DIR"/*.value; do
        [[ -e "$f" ]] || continue
        name=$(basename "$f" .value)
        value=$(cat "$f")
        rm -f "$f"
        export "$name=$value"
    done
    unset f name value
fi

[[ $# -gt 0 ]] || set -- claude

exec "$@"
