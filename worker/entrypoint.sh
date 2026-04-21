#!/bin/bash
# Worker entrypoint. Brings up Xvfb + fluxbox + x11vnc so Claude can drive a
# GUI if needed, then starts a tmux session running `claude` with the
# telegram-send MCP server registered via --mcp-config (strict, so the
# master's shared /root/.claude.json MCP list is ignored — this worker
# container can't reach the master's internal HTTP MCPs anyway). The
# master injects inbound messages by calling
#   docker exec <this-container> tmux send-keys -t claude "…" Enter

set -e

echo "root:${SSH_PASSWORD:-claude}" | chpasswd
/usr/sbin/sshd

# --- Inherit the master's Telegram bot token ---
# The master stores TELEGRAM_BOT_TOKEN in ~/.claude/channels/telegram/.env
# (written by /telegram:configure). Since /root/.claude is mounted from
# the master, the worker reads the same file — the shared bot speaks for
# both master and worker. Exported so the bun-hosted MCP server picks it
# up via process.env.
if [ -f /root/.claude/channels/telegram/.env ]; then
    set -a
    # shellcheck disable=SC1091
    . /root/.claude/channels/telegram/.env
    set +a
fi

# --- Graphical stack ---
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
Xvfb :1 -screen 0 "${SCREEN_GEOMETRY:-1920x1080x24}" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1
DISPLAY=:1 fluxbox >/tmp/fluxbox.log 2>&1 &
# No authentication on VNC by default — bind only to 127.0.0.1 in compose.
# Expose externally only behind Cloudflare Access or similar.
x11vnc -display :1 -forever -shared -rfbport 5900 -nopw -bg -o /tmp/x11vnc.log

# --- Claude Code auto-update (non-blocking) ---
claude update &>/dev/null &

# --- Pre-accept trust dialog for /workspace ---
# /root/.claude.json is shared with the master. The master uses /app as
# its cwd; we use /workspace. Stamp the workspace path as trusted so
# Claude doesn't ask on first launch. Safe to race with the master
# because we write to a different `.projects[path]` key.
if [ -f /root/.claude.json ]; then
    jq '.projects["/workspace"] //= {}
        | .projects["/workspace"].hasTrustDialogAccepted = true
        | .projects["/workspace"].hasClaudeMdExternalIncludesApproved = true' \
        /root/.claude.json > /tmp/patched.json \
        && cp /tmp/patched.json /root/.claude.json \
        && rm -f /tmp/patched.json
fi

# --- Seed default CLAUDE.md if the worker's workspace is still empty ---
if [ ! -f /workspace/CLAUDE.md ] && [ -f /opt/default-CLAUDE.md ]; then
    cp /opt/default-CLAUDE.md /workspace/CLAUDE.md
fi

# --- Bot-specific init hook ---
# WORKER_INIT_SCRIPT is set by routing.ts when the master compose defines
# it. The bot is responsible for providing the file (typically via
# WORKER_EXTRA_MOUNTS). Ran after the graphical stack is up and after the
# CLAUDE.md seed, so it can:
#   - prepare /workspace (e.g. git worktree add)
#   - configure git identity
#   - launch ancillary processes in detached tmux sessions (npm dev,
#     tunnels, watchers) so claude can see/manage them
# Errors here are non-fatal — log and continue, the worker can still come
# up and the user can debug from inside.
if [ -n "${WORKER_INIT_SCRIPT:-}" ] && [ -f "$WORKER_INIT_SCRIPT" ]; then
    mkdir -p /var/log/worker
    echo "[entrypoint] running WORKER_INIT_SCRIPT=$WORKER_INIT_SCRIPT" \
        >> /var/log/worker/init.log
    # shellcheck disable=SC1090
    bash "$WORKER_INIT_SCRIPT" >> /var/log/worker/init.log 2>&1 \
        || echo "[entrypoint] init script exited non-zero (rc=$?), continuing" \
            >> /var/log/worker/init.log
fi

# --- Start Claude in tmux ---
# Worker loads the same telegram channel-plugin the master uses. Because
# /root/.claude is shared with the master, the plugin finds the master's
# lock file at ~/.claude/channels/telegram/data/telegram.lock — so
# server.ts flips to isSecondary=true and skips bot.start() (no polling
# conflict with the master). TELEGRAM_ROLE=worker tells the fork's
# server.ts to hide topic-management tools and autofill chat_id/thread_id
# from the container's defaults.
#
# Master drives inbound via: docker exec <container> tmux send-keys -t claude
# Outbound goes through the full Fork tool surface (reply, react,
# edit_message, schedule, get_history, ask_user, telegraph_publish, …).
tmux kill-session -t claude 2>/dev/null || true
MODEL_ARGS=${CLAUDE_MODEL:+--model $CLAUDE_MODEL}
cd /workspace
tmux new-session -d -s claude \
    "claude $MODEL_ARGS --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"
mkdir -p /var/log/worker
tmux pipe-pane -o -t claude:0.0 'cat >> /var/log/worker/claude-stdout.log'

# Keep the container attached — exec tmux attach so logs flow to `docker logs`.
exec tmux attach -t claude
