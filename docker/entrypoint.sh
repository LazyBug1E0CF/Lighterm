#!/bin/sh
set -eu

DATA_DIR="${LIGHTERM_DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Compare two X.Y.Z semver strings; exits 0 when $1 > $2.
semver_gt() {
  v1=$(printf '%s' "$1" | sed 's/^[vV]//; s/[-+].*$//')
  v2=$(printf '%s' "$2" | sed 's/^[vV]//; s/[-+].*$//')
  case "$v1" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  case "$v2" in
    ''|*[!0-9.]*) return 0 ;;
  esac

  OLD_IFS=$IFS
  IFS=.
  set -- $v1
  a1=${1:-0}; [ -n "$a1" ] || a1=0
  a2=${2:-0}; [ -n "$a2" ] || a2=0
  a3=${3:-0}; [ -n "$a3" ] || a3=0
  set -- $v2
  b1=${1:-0}; [ -n "$b1" ] || b1=0
  b2=${2:-0}; [ -n "$b2" ] || b2=0
  b3=${3:-0}; [ -n "$b3" ] || b3=0
  IFS=$OLD_IFS

  if [ "$a1" -gt "$b1" ]; then return 0; fi
  if [ "$a1" -lt "$b1" ]; then return 1; fi
  if [ "$a2" -gt "$b2" ]; then return 0; fi
  if [ "$a2" -lt "$b2" ]; then return 1; fi
  if [ "$a3" -gt "$b3" ]; then return 0; fi
  return 1
}

run_supervisor() {
  export LIGHTERM_SELF_UPDATE="${LIGHTERM_SELF_UPDATE:-1}"
  DEFAULT_BIN="$1"
  shift
  BASE_STATIC_DIR="${LIGHTERM_STATIC_DIR:-/app/dist}"
  CURRENT_LINK="$DATA_DIR/app/current"
  CHILD_PID=""

  on_signal() {
    if [ -n "$CHILD_PID" ]; then
      kill -TERM "$CHILD_PID" 2>/dev/null || true
      wait "$CHILD_PID" 2>/dev/null || true
    fi
    exit 0
  }
  trap on_signal TERM INT

  while :; do
    IMAGE_VERSION=""
    if [ -r /app/VERSION ]; then
      IMAGE_VERSION=$(tr -d ' \t\r\n' < /app/VERSION)
    fi

    SERVER_BIN="$DEFAULT_BIN"
    TARGET_STATIC_DIR="$BASE_STATIC_DIR"
    USING_STAGED=0
    STAGED_VERSION=""

    if [ -x "$CURRENT_LINK/lighterm-server" ] \
       && [ -f "$CURRENT_LINK/dist/index.html" ] \
       && [ -r "$CURRENT_LINK/VERSION" ]; then
      STAGED_VERSION=$(tr -d ' \t\r\n' < "$CURRENT_LINK/VERSION")
      if [ -n "$STAGED_VERSION" ] && { [ -z "$IMAGE_VERSION" ] || semver_gt "$STAGED_VERSION" "$IMAGE_VERSION"; }; then
        SERVER_BIN="$CURRENT_LINK/lighterm-server"
        if [ "$BASE_STATIC_DIR" = "/app/dist" ]; then
          TARGET_STATIC_DIR="$CURRENT_LINK/dist"
        fi
        USING_STAGED=1
      fi
    fi

    START_TS=$(date +%s)
    LIGHTERM_STATIC_DIR="$TARGET_STATIC_DIR" "$SERVER_BIN" "$@" &
    CHILD_PID=$!

    set +e
    wait "$CHILD_PID"
    EXIT_CODE=$?
    set -e
    CHILD_PID=""

    # Exit code 42 means a new release was staged; immediately launch it.
    if [ "$EXIT_CODE" -eq 42 ]; then
      echo "Lighterm exited with restart code 42; activating updated release..." >&2
      continue
    fi

    # Roll back if a staged update crashes within 10s of startup with a non-zero exit code.
    if [ "$USING_STAGED" -eq 1 ] && [ "$EXIT_CODE" -ne 0 ]; then
      NOW_TS=$(date +%s)
      ELAPSED=$((NOW_TS - START_TS))
      if [ "$ELAPSED" -lt 10 ]; then
        echo "WARNING: Staged update ($STAGED_VERSION) exited with code $EXIT_CODE after ${ELAPSED}s; rolling back to built-in server." >&2
        rm -f "$CURRENT_LINK" "$DATA_DIR/app/active-version" 2>/dev/null || true
        continue
      fi
    fi

    exit "$EXIT_CODE"
  done
}

if [ "${1:-}" = "--supervise" ]; then
  shift
  run_supervisor "$@"
fi

SHOULD_SUPERVISE=0
if [ "${1:-}" = "/app/lighterm-server" ]; then
  SHOULD_SUPERVISE=1
fi

run_selected() {
  if [ "$SHOULD_SUPERVISE" -eq 1 ]; then
    run_supervisor "$@"
  else
    exec "$@"
  fi
}

# Already running as non-root (e.g., docker run --user / Kubernetes runAsNonRoot)
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  run_selected "$@"
fi

mkdir -p "$DATA_DIR"

# Explicit root execution requested
if [ "$PUID" = "0" ]; then
  run_selected "$@"
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
  if [ "$SHOULD_SUPERVISE" -eq 1 ]; then
    exec gosu "$PUID:$PGID" /app/entrypoint.sh --supervise "$@"
  else
    exec gosu "$PUID:$PGID" "$@"
  fi
fi

echo "WARNING: '$DATA_DIR' is not writable by UID:GID $PUID:$PGID after chown (host filesystem may restrict chown). Running as root; set PUID/PGID or host directory permissions to run non-root." >&2
export HOME=/home/lighterm
run_selected "$@"
