#!/bin/sh
set -eu

DATA_DIR="${LIGHTERM_DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Already running as non-root (e.g., docker run --user / Kubernetes runAsNonRoot)
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  exec "$@"
fi

mkdir -p "$DATA_DIR"

# Explicit root execution requested
if [ "$PUID" = "0" ]; then
  exec "$@"
fi

# Validate numeric PUID/PGID; fallback to 1000 if invalid
case "$PUID" in
  ''|*[!0-9]*) PUID=1000 ;;
esac
case "$PGID" in
  ''|*[!0-9]*) PGID=1000 ;;
esac

# Align lighterm user/group to requested PUID/PGID (supports existing GIDs like 100 via -o)
if [ "$(id -g lighterm)" != "$PGID" ]; then
  groupmod -o -g "$PGID" lighterm
fi
if [ "$(id -u lighterm)" != "$PUID" ]; then
  usermod -o -u "$PUID" lighterm
fi

# Fix ownership on data dir and home dir (non-recursive on home so read-only .ssh mounts stay intact)
chown "$PUID:$PGID" /home/lighterm 2>/dev/null || true
chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true

# Probe actual writability as target UID:GID; fallback to root with clear warning on NAS/FUSE mounts that ignore chown
if gosu "$PUID:$PGID" sh -c 'tmp="$1/.lighterm_write_probe.$$" && : > "$tmp" && rm -f "$tmp"' _ "$DATA_DIR" 2>/dev/null; then
  export HOME=/home/lighterm
  exec gosu "$PUID:$PGID" "$@"
fi

echo "WARNING: '$DATA_DIR' is not writable by UID:GID $PUID:$PGID after chown (host filesystem may restrict chown). Running as root; set PUID/PGID or host directory permissions to run non-root." >&2
export HOME=/home/lighterm
exec "$@"
