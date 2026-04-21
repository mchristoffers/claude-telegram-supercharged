#!/bin/bash
# Scaffold a fresh Supercharged Telegram bot end-to-end: directory skeleton,
# docker-compose.yml, Cloudflare tunnel route, Access policy, and bring-up.
#
# Usage:
#   scripts/new-bot.sh <bot-name> --token <telegram-bot-token> \
#       [--seed-from <existing-bot-dir>] \
#       [--subdomain <name>]            # default: <bot-name>-workers
#
# After this script finishes:
#   - /<parent>/<bot-name>/ is a working repo skeleton
#   - docker compose up -d has been run, container is alive
#   - <subdomain>.<CF_TUNNEL_DOMAIN> is live behind CF Access
#
# Required env: CLOUDFLARE_API_TOKEN in ~/.secrets.env (or ${SECRETS_ENV}).
# Everything else has sensible defaults that can be overridden via env:
#   CF_ACCOUNT_ID, CF_ZONE_ID, CF_TUNNEL_ID, CF_TUNNEL_DOMAIN,
#   CF_ACCESS_EMAIL, CF_INGRESS_CONFIG (path to homelab cloudflared-config.yml).

set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT_DIR="$(dirname "$FORK_DIR")"

usage() { sed -n '2,15p' "$0" >&2; exit 1; }

BOT=""; TOKEN=""; SEED_FROM=""; SUBDOMAIN=""
while [ $# -gt 0 ]; do
    case "$1" in
        --token) TOKEN="$2"; shift 2;;
        --seed-from) SEED_FROM="$2"; shift 2;;
        --subdomain) SUBDOMAIN="$2"; shift 2;;
        -h|--help) usage;;
        -*) echo "unknown flag: $1" >&2; usage;;
        *) [ -z "$BOT" ] && BOT="$1" || { echo "unexpected arg: $1" >&2; usage; }; shift;;
    esac
done
[ -n "$BOT" ] || usage
[ -n "$TOKEN" ] || { echo "--token is required" >&2; exit 1; }
SUBDOMAIN="${SUBDOMAIN:-${BOT}-workers}"

# shellcheck disable=SC1090
. "${SECRETS_ENV:-$HOME/.secrets.env}"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || {
    echo "CLOUDFLARE_API_TOKEN missing in secrets.env" >&2; exit 1; }

# Defaults for mchristoffers homelab — overridable via env for forks/clones.
: "${CF_ACCOUNT_ID:=a14f7a30af0305a224d8c3a890cf798f}"
: "${CF_ZONE_ID:=1efd3300a791a6ec4e7dd171c9493cae}"
: "${CF_TUNNEL_ID:=0ec8570d-c354-4524-8cb8-04016e884b9f}"
: "${CF_TUNNEL_DOMAIN:=mchristoffers.dev}"
: "${CF_ACCESS_EMAIL:=moritz.christoffers2911@gmail.com}"
: "${CF_INGRESS_CONFIG:=$HOME/git/mchristoffers/homelab/cloudflared-config.yml}"

BOT_DIR="$PARENT_DIR/$BOT"
[ -e "$BOT_DIR" ] && { echo "$BOT_DIR already exists — refusing to clobber" >&2; exit 1; }

# ── Pick free host ports ─────────────────────────────────────────
pick_port() {
    local start="$1"
    for p in $(seq "$start" $((start + 50))); do
        ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":$p\$" || { echo "$p"; return; }
    done
    echo "no free port near $start" >&2; exit 1
}
SSH_PORT="$(pick_port 2225)"
GW_PORT="$(pick_port 8091)"
echo "ports: SSH=$SSH_PORT gateway=$GW_PORT"

# ── Scaffold files ───────────────────────────────────────────────
mkdir -p "$BOT_DIR/root_claude/channels/telegram" "$BOT_DIR/project_claude"

cat > "$BOT_DIR/docker-compose.yml" <<YML
services:
  claude:
    build:
      context: $FORK_DIR/master
    env_file:
    - \${SECRETS_ENV:-/home/$(id -un)/.secrets.env}
    environment:
    - TZ=Europe/Berlin
    - CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
    - WORKER_HOST_BASE_DIR=$BOT_DIR
    - WORKER_IMAGE=$BOT-worker:latest
    - WORKER_SECRETS_ENV=\${SECRETS_ENV:-/home/$(id -un)/.secrets.env}
    - ROUTES_FILE=/root/.claude/channels/telegram/routes.json
    - TOPICS_FILE=/root/.claude/channels/telegram/topics.json
    - GATEWAY_PORT=$GW_PORT
    volumes:
    - ./root_claude:/root/.claude
    - ./root_claude.json:/root/.claude.json
    - ./project_claude:/app/.claude
    - $FORK_DIR:/opt/telegram-supercharged
    - uv-cache:/root/.cache/uv
    - uv-tools:/root/.local/share/uv
    - claude-bin:/root/.local/share/claude
    - /var/run/docker.sock:/var/run/docker.sock
    - \${SECRETS_ENV:-/home/$(id -un)/.secrets.env}:\${SECRETS_ENV:-/home/$(id -un)/.secrets.env}:ro
    ports:
    - '$SSH_PORT:22'
    - '$GW_PORT:$GW_PORT'
    stdin_open: true
    tty: true
    restart: unless-stopped
    mem_limit: 2g
    memswap_limit: 2g
  worker:
    build: $FORK_DIR/worker
    image: $BOT-worker:latest
    profiles: ["build"]

volumes:
  uv-cache: null
  uv-tools: null
  claude-bin: null
YML

cat > "$BOT_DIR/.gitignore" <<'EOF'
.env
root_claude/
root_claude.json
project_claude/
EOF

cat > "$BOT_DIR/.env.example" <<'EOF'
SSH_PASSWORD=CHANGE_ME
EOF
echo "SSH_PASSWORD=claude" > "$BOT_DIR/.env"

echo '{"mcpServers": {}}' > "$BOT_DIR/.mcp.json"

cat > "$BOT_DIR/README.md" <<EOF
# $BOT

Self-hosted Claude Code accessible via Telegram, built on
[claude-telegram-supercharged](https://github.com/mchristoffers/claude-telegram-supercharged).

- **SSH:** \`ssh -p $SSH_PORT root@<host>\` (password from \`SSH_PASSWORD\`)
- **Workers panel:** https://$SUBDOMAIN.$CF_TUNNEL_DOMAIN
- **tmux:** \`docker exec -it ${BOT}-claude-1 tmux attach -t claude\`
EOF

cat > "$BOT_DIR/CLAUDE.md" <<EOF
# CLAUDE.md

Thin wrapper around the Supercharged fork. All worker/gateway/routing logic
lives in $FORK_DIR. This repo only contains wiring
(docker-compose.yml) and bot-specific state (root_claude/, project_claude/).

SSH port: $SSH_PORT · gateway port: $GW_PORT · subdomain: $SUBDOMAIN.$CF_TUNNEL_DOMAIN
EOF

# Must be a FILE, not a dir (docker bind-mount would create a directory and
# fail container startup). Entrypoint overwrites this on first boot.
echo '{}' > "$BOT_DIR/root_claude.json"
echo "TELEGRAM_BOT_TOKEN=$TOKEN" > "$BOT_DIR/root_claude/channels/telegram/.env"
chmod 600 "$BOT_DIR/root_claude/channels/telegram/.env"

# ── Optional: seed OAuth from an existing working bot ────────────
if [ -n "$SEED_FROM" ]; then
    [ -f "$SEED_FROM/root_claude/.credentials.json" ] || {
        echo "seed-from: no .credentials.json in $SEED_FROM" >&2; exit 1; }
    sudo cp "$SEED_FROM/root_claude/.credentials.json" \
        "$BOT_DIR/root_claude/.credentials.json"
    sudo chown "$(id -u):$(id -g)" "$BOT_DIR/root_claude/.credentials.json"
    # Inherit plugin marketplace state so first boot skips the network install.
    sudo cp -r "$SEED_FROM/root_claude/plugins" "$BOT_DIR/root_claude/plugins"
    sudo chown -R "$(id -u):$(id -g)" "$BOT_DIR/root_claude/plugins"
    echo "seeded OAuth + plugins from $SEED_FROM"
fi

# ── Cloudflare tunnel wiring ─────────────────────────────────────
cf() {
    curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H "Content-Type: application/json" "$@"
}

echo "creating DNS $SUBDOMAIN.$CF_TUNNEL_DOMAIN → tunnel"
cf -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
    -d "{\"type\":\"CNAME\",\"name\":\"$SUBDOMAIN\",\"content\":\"$CF_TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" \
    | jq -r '"  → " + .result.name'

echo "creating Access app + policy"
APP_ID="$(cf -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
    -d "{\"name\":\"$SUBDOMAIN\",\"domain\":\"$SUBDOMAIN.$CF_TUNNEL_DOMAIN\",\"type\":\"self_hosted\",\"session_duration\":\"720h\"}" \
    | jq -r '.result.id')"
cf -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$APP_ID/policies" \
    -d "{\"name\":\"owner only\",\"decision\":\"allow\",\"include\":[{\"email\":{\"email\":\"$CF_ACCESS_EMAIL\"}}],\"precedence\":1}" \
    > /dev/null
echo "  → $APP_ID"

echo "appending ingress entry to $CF_INGRESS_CONFIG"
# Insert new hostname *before* the catch-all 404 rule at the bottom.
awk -v host="$SUBDOMAIN.$CF_TUNNEL_DOMAIN" -v port="$GW_PORT" '
    /^  - service: http_status:404/ {
        print "  - hostname: " host
        print "    service: http://172.17.0.1:" port
    }
    { print }
' "$CF_INGRESS_CONFIG" > "$CF_INGRESS_CONFIG.tmp" && mv "$CF_INGRESS_CONFIG.tmp" "$CF_INGRESS_CONFIG"

echo "restarting cloudflared tunnel"
(cd "$(dirname "$CF_INGRESS_CONFIG")" && docker compose restart tunnel 2>&1 | tail -2) || \
    echo "⚠ could not auto-restart tunnel — do it manually in the homelab stack"

# ── Bring up the bot ─────────────────────────────────────────────
echo "building worker image"
(cd "$BOT_DIR" && docker compose build worker 2>&1 | tail -3)

echo "starting bot"
(cd "$BOT_DIR" && docker compose up -d 2>&1 | tail -3)

echo
echo "✓ $BOT is up"
echo "  dir:        $BOT_DIR"
echo "  ssh:        ssh -p $SSH_PORT root@<host>"
echo "  workers:    https://$SUBDOMAIN.$CF_TUNNEL_DOMAIN"
echo "  attach:     docker exec -it ${BOT}-claude-1 tmux attach -t claude"
if [ -z "$SEED_FROM" ]; then
    echo
    echo "⚠  no OAuth seed — run 'docker exec -it ${BOT}-claude-1 claude /login'"
    echo "   or rerun with --seed-from <other-bot-dir>"
fi
