#!/usr/bin/env bash
# Takes a Docker registry config on stdin: the ACR pull token the nested engine needs,
# minted on the host because a mounted ~/.azure may hold no usable session on macOS and
# an in-container `az` would fail.
#
# It lives on the secrets tmpfs with ~/.docker/config.json symlinked at it, so the token
# is where every tool looks for it without ever being written to a disk.
set -euo pipefail

dir="${HAI_SECRETS_DIR:?HAI_SECRETS_DIR is not set}"

umask 077
mkdir -p "$dir/docker" "$HOME/.docker"
cat >"$dir/docker/config.json"

if [ ! -e "$HOME/.docker/config.json" ] || [ -L "$HOME/.docker/config.json" ]; then
    ln -sfn "$dir/docker/config.json" "$HOME/.docker/config.json"
fi
