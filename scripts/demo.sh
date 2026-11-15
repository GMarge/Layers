#!/bin/bash
# Start Layers for a demo: the API, the web app, then the first screen.
# Safe to run twice: whatever is already running is left alone.
#
#   ~/layers/scripts/demo.sh            start what is not running, then open the first screen
#   ~/layers/scripts/demo.sh --no-open  the same, without opening the browser

cd "$(dirname "$0")/.." || exit 1
up() { curl -s -m 2 -o /dev/null "$1"; }

if up http://127.0.0.1:8000/api/health; then
  echo "The API is already running."
else
  echo "Starting the API..."
  nohup .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8000 > /tmp/layers-api.log 2>&1 &
fi

if up http://localhost:5173/; then
  echo "The web app is already running."
else
  echo "Starting the web app..."
  nohup npm --prefix web run dev > /tmp/layers-web.log 2>&1 &
fi

for _ in $(seq 1 60); do
  up http://127.0.0.1:8000/api/health && up http://localhost:5173/ && break
  sleep 0.5
done

if up http://127.0.0.1:8000/api/health && up http://localhost:5173/; then
  if curl -s -m 3 http://127.0.0.1:8000/api/health | grep -q '"agent": *true'; then
    echo "Ready, with the live agent."
  else
    echo "Ready, but on rules only: no model is connected. Check .env and the internet."
  fi
  [ "$1" = "--no-open" ] || open "http://localhost:5173/#intro"
else
  echo "Something did not start. Look at /tmp/layers-api.log and /tmp/layers-web.log."
  exit 1
fi
