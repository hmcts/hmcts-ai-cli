#!/usr/bin/env bash
# The container's main process: bring up the nested Docker engine, then stay up so the
# session execs have something to attach to. Run as root, because dockerd needs to be.
#
# Staged by hai into its state directory and bind-mounted read-only at /opt/hai, so it is
# invoked as `bash /opt/hai/supervisor.sh` and needs no execute bit.
set -uo pipefail

log() { printf 'hai-supervisor: %s\n' "$*"; }

# The container has its own network namespace, so the nested daemon's containers cannot
# reach the host's resolver. They inherit this container's /etc/resolv.conf, which on a
# user-defined bridge is Docker's own 127.0.0.11 — a loopback address dockerd discards,
# falling back to a public resolver and losing every *.internal name. Naming the
# resolvers in daemon.json is what keeps AAT reachable from a nested container.
if [[ -n "${HAI_NESTED_DNS:-}" ]]; then
    servers=$(printf '%s' "$HAI_NESTED_DNS" | tr ',' '\n' | sed '/^$/d; s/.*/"&"/' | paste -sd, -)
    if [[ -n "$servers" ]]; then
        mkdir -p /etc/docker
        printf '{"dns": [%s]}\n' "$servers" >/etc/docker/daemon.json
    fi
fi

dockerd >/var/log/hai-dockerd.log 2>&1 &

for _ in $(seq 1 "${HAI_DOCKERD_WAIT:-60}"); do
    docker version >/dev/null 2>&1 && break
    sleep 1
done

if docker version >/dev/null 2>&1; then
    log "nested Docker engine up"
    # HMCTS images are often amd64-only and a daemon this new has no qemu registered.
    case "$(uname -m)" in
        aarch64 | arm64)
            docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null 2>&1 ||
                log "could not register qemu/binfmt; amd64-only images will not run"
            ;;
    esac
else
    log "nested Docker engine did not come up; see /var/log/hai-dockerd.log"
fi

# Nothing to do but outlive the session execs. --init reaps for us.
exec sleep infinity
