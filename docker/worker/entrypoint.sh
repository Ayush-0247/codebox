#!/bin/bash
set -e

ISOLATE_CONFIG=/usr/local/etc/isolate
# cgroup root for isolate boxes, read from isolate's own config so the two
# can never disagree (default /sys/fs/cgroup/isolate).
CG_ROOT=$(sed -n 's/^cg_root *= *//p' "$ISOLATE_CONFIG" 2>/dev/null | head -1)
CG_ROOT=${CG_ROOT:-/sys/fs/cgroup/isolate}
# Leaf cgroup for this container's own processes (unique per stack when
# several CodeBox workers share one host cgroup tree).
WORKER_CGROUP=${WORKER_CGROUP:-worker}

# Create isolate directories
mkdir -p /var/local/lib/isolate /run/isolate

# Set up cgroup v2 for isolate
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # Create a leaf cgroup for the worker process
    mkdir -p "/sys/fs/cgroup/$WORKER_CGROUP"

    # Move current shell into the worker cgroup
    # so the root cgroup has no direct processes
    if ! echo $$ > "/sys/fs/cgroup/$WORKER_CGROUP/cgroup.procs" 2>/dev/null; then
        echo "WARNING: Failed to move process to worker cgroup" >&2
    fi

    # Enable controllers at root level (needs no processes in root)
    if ! echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
        echo "WARNING: Failed to enable cgroup controllers at root" >&2
    fi

    # Create dedicated cgroup subtree for isolate boxes
    mkdir -p "$CG_ROOT"
    if ! echo "+cpu +memory +pids" > "$CG_ROOT/cgroup.subtree_control" 2>/dev/null; then
        echo "WARNING: Failed to enable cgroup controllers for isolate" >&2
    fi

    echo "Cgroup v2 setup complete for isolate ($CG_ROOT)"
else
    echo "WARNING: cgroup v2 not detected, isolate may not work" >&2
fi

# Optional privilege drop (WORKER_USER, e.g. "codebox"): the Node.js worker
# then runs without root's file access and capabilities; the setuid isolate
# binary still creates and enters the sandboxes. Everything above needs root
# and has already run.
if [ -n "$WORKER_USER" ] && [ "$(id -u)" = "0" ]; then
    mkdir -p /var/cache/codebox
    chown -R "$WORKER_USER:" /var/cache/codebox
    exec setpriv --reuid="$WORKER_USER" --regid="$WORKER_USER" --init-groups --inh-caps=-all "$@"
fi

exec "$@"
