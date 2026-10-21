#!/usr/bin/env bash
# Supervisor for the HTTP server.
#
# Deliberately not a process manager: it starts the server, and if the process
# dies with a non-zero status it waits 5 seconds and starts it again. A clean
# exit (status 0) stops the loop, so `systemctl stop` or Ctrl-C does not fight
# a restart. For anything more elaborate, use the systemd unit.
set -u

cd "$(dirname "$0")/.." || exit 1

if [ ! -f dist/main.js ]; then
  echo "dist/main.js is missing — run 'npm run build' first." >&2
  exit 1
fi

while true; do
  node dist/main.js
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "Server exited cleanly; not restarting." >&2
    exit 0
  fi
  echo "Server exited with status $status; restarting in 5s." >&2
  sleep 5
done
