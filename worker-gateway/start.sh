#!/bin/bash
# Starts the per-topic worker noVNC gateway in a tmux session.
#
# Expected environment (set by the bot's docker-compose service):
#   ALLOWED_EMAIL   — CF Access identity allowed to use the panel
#   GATEWAY_PORT    — default 8090 (must match compose `ports:` mapping)
#   ROUTES_FILE     — path to routes.json (default /root/.claude/channels/telegram/routes.json)
#   TOPICS_FILE     — path to topics.json (default /root/.claude/channels/telegram/topics.json)
#
# The bot's entrypoint must also:
#   - mount /var/run/docker.sock
#   - attach to Docker default `bridge` (so gateway can reach worker IPs:5900)
#   - expose GATEWAY_PORT to the host
#
# Call from the bot's entrypoint.sh:
#   bash /opt/telegram-supercharged/worker-gateway/start.sh

set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="${GATEWAY_LOG_DIR:-/root/.claude/channels/telegram/data}"
LOG="$LOGDIR/gateway-stdout.log"

mkdir -p "$LOGDIR"
: > "$LOG"

(cd "$DIR" && bun install --silent 2>&1 | tail -5) || true

tmux kill-session -t gateway 2>/dev/null || true
tmux new-session -d -s gateway "cd $DIR && bun run src/server.ts"
tmux pipe-pane -o -t gateway:0.0 "cat >> $LOG"
