#!/usr/bin/env bash
#
# Starts and stops the local API + worker reliably.
#
# This exists because doing it by hand went wrong repeatedly: `pkill -f
# "worker/dist/main.js"` never matches, because the running command is
# `node dist/main.js` with the path relative to the app directory. The result
# was seven worker processes from different builds all consuming the same
# queue, producing results that looked like a subtle concurrency bug in the
# pipeline and were nothing of the sort.
#
# PID files make "is it running, and which build?" answerable, and stop actually
# stops.
#
# Usage: scripts/dev-stack.sh {start|stop|restart|status|logs}

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/.dev"
mkdir -p "$RUN_DIR"

APPS=(api worker)

pid_file() { echo "$RUN_DIR/$1.pid"; }
log_file() { echo "$RUN_DIR/$1.log"; }

is_running() {
  local pid_path
  pid_path="$(pid_file "$1")"
  [[ -f "$pid_path" ]] && kill -0 "$(cat "$pid_path")" 2>/dev/null
}

stop_app() {
  local app=$1 pid_path
  pid_path="$(pid_file "$app")"

  if [[ -f "$pid_path" ]]; then
    local pid
    pid=$(cat "$pid_path")
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$pid" 2>/dev/null || true
    rm -f "$pid_path"
  fi

  if [[ "$app" == api ]]; then
    # Belt and braces: anything still holding the port is ours and is stale.
    lsof -ti:3001 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  fi
}

start_app() {
  local app=$1

  if is_running "$app"; then
    echo "  $app already running (pid $(cat "$(pid_file "$app")"))"
    return
  fi

  # node is launched directly rather than through `pnpm start:local`, which
  # would put pnpm and dotenv-cli between us and the process we need to signal
  # — the reason an earlier version left orphans behind. The recorded PID is
  # the node process itself, so stopping it actually stops it.
  #
  # `set -a` exports everything sourced from .env, replacing dotenv-cli.
  (
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
    cd "$ROOT/apps/$app"
    nohup node dist/main.js > "$(log_file "$app")" 2>&1 &
    echo $! > "$(pid_file "$app")"
  )
  echo "  $app started (pid $(cat "$(pid_file "$app")"))"
}

case "${1:-status}" in
  start)
    echo "Starting:"
    for app in "${APPS[@]}"; do start_app "$app"; done

    printf '  waiting for the API to become ready'
    for _ in $(seq 1 60); do
      if curl -sf http://localhost:3001/api/v1/health/ready > /dev/null 2>&1; then
        echo " — ready"
        exit 0
      fi
      printf '.'
      sleep 1
    done
    echo " — TIMED OUT (see $RUN_DIR/api.log)"
    exit 1
    ;;

  stop)
    echo "Stopping:"
    for app in "${APPS[@]}"; do
      stop_app "$app"
      echo "  $app stopped"
    done
    # Catch anything started outside this script during development.
    pkill -f 'dist/main\.js' 2>/dev/null || true
    ;;

  restart)
    "$0" stop
    "$0" start
    ;;

  status)
    for app in "${APPS[@]}"; do
      if is_running "$app"; then
        echo "  $app: running (pid $(cat "$(pid_file "$app")"))"
      else
        echo "  $app: stopped"
      fi
    done
    # A count above the number of apps means strays are competing for the queue.
    echo "  node processes matching dist/main.js: $(pgrep -f 'node dist/main\.js' | wc -l | tr -d ' ')"
    ;;

  logs)
    tail -n "${3:-40}" "$(log_file "${2:-worker}")"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|logs [api|worker] [lines]}"
    exit 1
    ;;
esac
