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

5. **Restart Kackstein** so the entrypoint re-runs the plugin-cache overlay:
   ```bash
   docker restart personal-claude-1
   ```
   This re-applies `entrypoint.sh` which copies `/opt/telegram-supercharged/server.ts` and `skills/` into the active plugin cache dir, then the supervisor respawns Claude with fresh code. Takes ~5-10s before the bot is back online.

6. **Report** to Moritz in one line: commit hash + what shipped + "kackstein restarted". Don't recap the diff — he just read it.

## When NOT to ship

- Work-in-progress changes the user said are still being iterated on.
- Pure docs/README edits (no daemon reload needed — push, skip the restart).
- Changes to files outside the daemon's runtime path (`.github/`, `LICENSE`, `banner.jpg`).

## If the push or restart fails

- **Push rejected**: probably new upstream commits. `git pull --rebase upstream master` (or `origin master` if the user pushed from elsewhere), resolve, retry. Do not force-push.
- **Container restart fails**: check `docker ps -a | grep personal-claude` — if the container is missing or stuck, the compose project in `/home/moritz/git/mchristoffers/personal/` is where it's defined. Don't rebuild from /ship; report to the user.
