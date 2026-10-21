#!/usr/bin/env bash
# Takes a credential's variable name as its argument and the value on stdin, so the value
# reaches the container without passing through the container config, an argv or a shell.
# The session entrypoint exports it and deletes the file.
set -euo pipefail

name="${1:?usage: receive-secret.sh NAME}"
dir="${HAI_SECRETS_DIR:?HAI_SECRETS_DIR is not set}"

case "$name" in
    *[!A-Za-z0-9_]* | "")
        printf 'receive-secret: %s is not a usable environment variable name\n' "$name" >&2
        exit 2
        ;;
esac

umask 077
mkdir -p "$dir"
cat >"$dir/$name.value"
