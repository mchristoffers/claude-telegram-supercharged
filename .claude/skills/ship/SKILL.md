---
name: ship
description: Ship a change to Kackstein. Use after every code change or new feature in this repo — commits, pushes to origin, and restarts the personal-claude-1 daemon so the change goes live. Trigger whenever a file in this repo (server.ts, supervisor.ts, skills/, scripts/) was edited and the work is complete.
user-invocable: true
allowed-tools:
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(git add*)
  - Bash(git commit*)
  - Bash(git push*)
  - Bash(docker restart*)
  - Bash(docker ps*)
  - Bash(docker exec*)
---

# /ship — Deploy a change to Kackstein

Run this after **every** finished code change in `claude-telegram-supercharged`. The repo is volume-mounted into the `personal-claude-1` container, but the running bot loads from the plugin cache at `/root/.claude/plugins/cache/claude-plugins-official/telegram/<version>/`. The container's entrypoint overlays our `server.ts`/`skills/` on top of that cache on every startup — so a **container restart** is what guarantees the new code is live. Killing just the claude process inside won't reapply the overlay and leaves you deploying a stale cached version.

## Steps

1. **Check what changed**
   ```bash
   git status --short
   git diff --stat
   ```
   Bail out if the working tree is clean (nothing to ship).

2. **Stage only relevant files** — never `git add -A` or `git add .`. Add the specific paths that belong to this change. Skip `node_modules/`, lockfile churn unrelated to the change, and any `.tmp`/`.log` debris.

3. **Commit** with a short imperative subject (≤72 chars), no co-author trailer needed unless the user asks. Body only if the *why* is non-obvious. Example:
   ```
   Drop Telegram reminder on schedule fire — channel notification only
   ```

4. **Push**
   ```bash
   git push origin master
   ```

5. **Force-overwrite the plugin cache from the mounted fork.** Don't trust the entrypoint to pick everything up — explicitly mirror every fork file the daemon reads (server.ts, skills/, supervisor.ts) into the live cache + script paths. This is idempotent and runs on every ship so a forgotten file in the entrypoint can never silently leave stale code running.
   ```bash
   docker exec personal-claude-1 bash -c '
     for TGDIR in $(find /root/.claude/plugins/cache/claude-plugins-official/telegram -mindepth 1 -maxdepth 1 -type d 2>/dev/null) \
                  /root/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram; do
       [ -d "$TGDIR" ] || continue
       cp /opt/telegram-supercharged/server.ts "$TGDIR/server.ts"
       [ -d /opt/telegram-supercharged/skills ] && cp -r /opt/telegram-supercharged/skills/. "$TGDIR/skills/"
     done
     mkdir -p /root/.claude/scripts
     cp /opt/telegram-supercharged/supervisor.ts /root/.claude/scripts/telegram-supervisor.ts
   '
   ```

6. **Restart Kackstein** so the supervisor respawns Claude with the fresh code:
   ```bash
   docker restart personal-claude-1
   ```
   Takes ~5-10s before the bot is back online.

6. **Report** to Moritz in one line: commit hash + what shipped + "kackstein restarted". Don't recap the diff — he just read it.

## When NOT to ship

- Work-in-progress changes the user said are still being iterated on.
- Pure docs/README edits (no daemon reload needed — push, skip the restart).
- Changes to files outside the daemon's runtime path (`.github/`, `LICENSE`, `banner.jpg`).

## If the push or restart fails

- **Push rejected**: probably new upstream commits. `git pull --rebase upstream master` (or `origin master` if the user pushed from elsewhere), resolve, retry. Do not force-push.
- **Container restart fails**: check `docker ps -a | grep personal-claude` — if the container is missing or stuck, the compose project in `/home/moritz/git/mchristoffers/personal/` is where it's defined. Don't rebuild from /ship; report to the user.
