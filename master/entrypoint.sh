#!/bin/bash

echo "root:${SSH_PASSWORD:-claude}" | chpasswd
/usr/sbin/sshd

# ── First-boot bootstrap (idempotent) ────────────────────────────
# When a bot is spun up with empty mounted state, Claude Code's interactive
# onboarding (theme picker, trust dialog, bypass-permissions warning) blocks
# the supervisor TTY forever. Seed the minimum files that skip all prompts.
# Each step is a no-op if the target file already has content — safe to run
# on every boot, never clobbers existing setup.

# .claude.json: file (not dir, or docker bind-mount creates a directory and
# container startup crashes). Onboarding flags + /app project marked trusted.
if [ ! -s /root/.claude.json ] || [ "$(cat /root/.claude.json 2>/dev/null)" = "{}" ]; then
    cat > /root/.claude.json <<'JSON'
{
  "hasCompletedOnboarding": true,
  "projects": {
    "/app": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
JSON
fi

# settings.json: enables the telegram plugin and suppresses the bypass-mode
# warning that Claude Code otherwise shows on every launch under
# --dangerously-skip-permissions.
if [ ! -f /root/.claude/settings.json ]; then
    mkdir -p /root/.claude
    cat > /root/.claude/settings.json <<'JSON'
{
  "enabledPlugins": {
    "telegram@claude-plugins-official": true
  },
  "skipDangerousModePermissionPrompt": true
}
JSON
fi

# Telegram bot token: the plugin reads this from channels/telegram/.env.
# Accept TELEGRAM_BOT_TOKEN from the compose env as a more ergonomic source
# and materialise the file on first boot.
mkdir -p /root/.claude/channels/telegram
if [ ! -f /root/.claude/channels/telegram/.env ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN" > /root/.claude/channels/telegram/.env
    chmod 600 /root/.claude/channels/telegram/.env
fi

# Plugin marketplace + telegram plugin: without these the --channels flag
# silently fails with "plugin not installed" and the bot is deaf.
if [ ! -d /root/.claude/plugins/marketplaces/claude-plugins-official ]; then
    echo "[bootstrap] installing telegram plugin marketplace…"
    claude plugin marketplace add anthropics/claude-plugins-official 2>&1 | tail -3 || true
    claude plugin install telegram@claude-plugins-official 2>&1 | tail -3 || true
fi

# Attach ourselves to the Docker default `bridge` network so the in-container
# worker-gateway can TCP-connect to worker containers (routing.ts spawns
# without --network, so workers land on bridge). Compose cannot add us to
# default bridge because Docker rejects network-scoped aliases on it — so we
# do it post-start via the docker socket (same mechanism routing.ts uses).
docker network connect bridge "$(hostname)" 2>/dev/null || true

# Auto-update Claude Code on start (non-blocking)
claude update &>/dev/null &

# Overlay supercharged telegram plugin — fully overwrite cache from the fork
# every boot so a stale file in the cache can never silently override the new
# code. server.ts + supervisor.ts are simple file copies; skills/ is wiped and
# repopulated so deletions in the fork propagate too. node_modules in $TGDIR
# is preserved because we don't touch the dir itself.
for TGDIR in \
    $(find /root/.claude/plugins/cache/claude-plugins-official/telegram -mindepth 1 -maxdepth 1 -type d 2>/dev/null) \
    /root/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram; do
    [ -d "$TGDIR" ] || continue
    cp -f /opt/telegram-supercharged/server.ts "$TGDIR/server.ts"
    # Per-topic routing module — imported by server.ts
    cp -f /opt/telegram-supercharged/routing.ts "$TGDIR/routing.ts" 2>/dev/null || true
    if [ -d /opt/telegram-supercharged/skills ]; then
        rm -rf "$TGDIR/skills"
        cp -r /opt/telegram-supercharged/skills "$TGDIR/skills"
    fi
    # Install extra dependencies needed by supercharged server.ts
    (cd "$TGDIR" && bun add croner 2>/dev/null)
done
mkdir -p /root/.claude/scripts
cp -f /opt/telegram-supercharged/supervisor.ts /root/.claude/scripts/telegram-supervisor.ts

# Replace expect wrapper with plain bash — expect garbles terminal output in tmux
cat > /root/.claude/scripts/claude-daemon-wrapper.exp <<'WRAPPER'
#!/bin/bash
exec claude "$@"
WRAPPER
chmod +x /root/.claude/scripts/claude-daemon-wrapper.exp

# Ensure telegram data dir exists and clear stale lock
mkdir -p /root/.claude/channels/telegram/data
rm -f /root/.claude/channels/telegram/data/telegram.lock

# Symlink memory dirs for all ccswitch profiles to main profile — keeps them in sync
for profile_dir in /root/.claude/*/; do
    [ -d "${profile_dir}projects" ] || continue
    for project_dir in /root/.claude/projects/*/; do
        [ -d "$project_dir" ] || continue
        project=$(basename "$project_dir")
        mkdir -p "/root/.claude/projects/${project}/memory"   # ensure target exists
        mkdir -p "${profile_dir}projects/${project}"          # ensure parent exists
        rm -rf "${profile_dir}projects/${project}/memory"     # remove dir or stale symlink
        ln -sf "/root/.claude/projects/${project}/memory" "${profile_dir}projects/${project}/memory"
    done
done

# Bot-specific init (MCP registrations, extra env wiring, …). Each bot
# that mounts the supercharged master image provides its own bot-init.sh
# at /opt/bot-init.sh — typically via a compose volume mount. Safe to
# skip if none is provided.
if [ -x /opt/bot-init.sh ]; then
    /opt/bot-init.sh
fi

# noVNC gateway — serves the worker panel on :8090 alongside supervisor.
# Lives in the master container because the master already owns the docker
# socket and routes.json/topics.json. Reached via CF tunnel at
# workers.mchristoffers.dev.
[ -x /opt/telegram-supercharged/worker-gateway/start.sh ] && \
    bash /opt/telegram-supercharged/worker-gateway/start.sh || true

# Start via supervisor in tmux — attach with: docker exec -it personal-claude-1 tmux attach -t claude
# Detached + pipe-pane so the supervisor's pane stdout (claude's TTY output)
# is mirrored to supervisor-stdout.log for the context watchdog and /usage.
# We can't pipe through `tee`/`script` directly because Claude needs a real
# TTY on stdout — otherwise it falls back to --print mode and crashes.
tmux kill-session -t claude 2>/dev/null || true
MODEL_ARGS=${CLAUDE_MODEL:+--model $CLAUDE_MODEL}
mkdir -p /root/.claude/channels/telegram/data
: > /root/.claude/channels/telegram/data/supervisor-stdout.log
tmux new-session -d -s claude "bun /root/.claude/scripts/telegram-supervisor.ts $MODEL_ARGS"
tmux pipe-pane -o -t claude:0.0 'cat >> /root/.claude/channels/telegram/data/supervisor-stdout.log'
exec tmux attach -t claude
