/**
 * Per-topic routing for the Telegram channel.
 *
 * Master (Kackstein) polls Telegram. For each inbound Forum-topic message:
 *   resolveRoute(chat_id, thread_id)
 *     → hit in routes.json              → dispatchToWorker
 *     → miss AND thread_id set          → ensureWorker (spawn container,
 *                                           wait for tmux, append route)
 *                                           → dispatchToWorker
 *     → miss AND thread_id undefined    → return undefined → master handles it
 *
 * Dispatch is plain `docker exec <container> tmux send-keys`, not HTTP or
 * channels — the worker is a regular `claude` CLI session and the input
 * looks like a user typing at a terminal. Replies come back out through
 * the worker's own MCP tools (telegram-send MCP or, in Weg B, the fork's
 * full channel-plugin tool surface in TELEGRAM_ROLE=worker mode).
 *
 * routes.json single-source-of-truth: only the master reads and writes.
 * Atomic rewrite (tmp + rename) + in-memory spawn lock guards concurrent
 * first-message-in-new-topic bursts.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  watchFile,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".claude", "channels", "telegram");
const ROUTES_FILE = join(STATE_DIR, "routes.json");
// Cache of Forum topic names. Populated by server.ts whenever it sees a
// `forum_topic_created` or `forum_topic_edited` service message, so
// freshly-auto-spawned workers can be named after their topic instead
// of just `worker-t<id>`. Topics that existed before this cache was
// introduced stay nameless (→ fall back to worker-t<id>).
const TOPICS_CACHE_FILE = join(STATE_DIR, "topics.json");
const TMUX_SESSION = process.env.TELEGRAM_WORKER_TMUX_SESSION ?? "claude";
const DISPATCH_TIMEOUT_MS = 10_000;
const SPAWN_TIMEOUT_MS = 60_000;
const TMUX_READY_TIMEOUT_MS = 45_000;

const WORKER_IMAGE = process.env.WORKER_IMAGE ?? "personal-worker-test:latest";
const WORKER_HOST_BASE_DIR = process.env.WORKER_HOST_BASE_DIR ?? "";
const WORKER_SECRETS_ENV = process.env.WORKER_SECRETS_ENV ?? "/home/moritz/.secrets.env";

// Generic extension hooks. Bots wrapping Supercharged use these to give
// their workers extra mounts (source repos, host binaries, config dirs)
// and a custom init script that runs before the in-tmux claude session
// starts. See the consuming bot's docker-compose.yml for examples.
//
// WORKER_EXTRA_MOUNTS: comma-separated docker -v specs, e.g.
//   "/host/repo:/srv/source,/host/bin/foo:/usr/local/bin/foo:ro"
// Whitespace around entries is trimmed; empty entries are ignored.
//
// WORKER_INIT_SCRIPT: absolute path inside the worker container. If set,
// the worker's entrypoint sources this file after the graphical stack is
// up and before claude starts. The bot is responsible for mounting it in
// via WORKER_EXTRA_MOUNTS.
const WORKER_EXTRA_MOUNTS = process.env.WORKER_EXTRA_MOUNTS ?? "";
const WORKER_INIT_SCRIPT = process.env.WORKER_INIT_SCRIPT ?? "";

function parseExtraMounts(spec: string): string[] {
  const args: string[] = [];
  for (const entry of spec.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    args.push("-v", trimmed);
  }
  return args;
}

export type Route = {
  chat_id: string;
  thread_id?: number;
  container: string;
  label?: string;
};

type RoutesFile = { routes?: Route[] };

let cachedRoutes: Route[] = [];
let lastMtime = 0;

/**
 * Optional Telegram hook used to post/edit a status line in the topic
 * while a worker is being spawned. Registered by server.ts once its
 * grammy bot is built. routing.ts doesn't import grammy — only calls the
 * narrow interface below — so this file stays testable standalone.
 */
export type StatusBot = {
  sendMessage: (
    chatId: string,
    text: string,
    opts?: { message_thread_id?: number },
  ) => Promise<{ message_id: number }>;
  editMessageText: (
    chatId: string,
    messageId: number,
    text: string,
  ) => Promise<unknown>;
  /**
   * Probe whether a Forum topic still exists. The GC loop uses this —
   * sendChatAction is cheap, and Telegram returns "thread not found"
   * when the topic has been deleted. Throws on other errors (network,
   * auth, etc.) so the caller keeps the route conservatively.
   */
  sendChatAction: (
    chatId: string,
    action: "typing",
    opts?: { message_thread_id?: number },
  ) => Promise<unknown>;
};
let statusBot: StatusBot | null = null;
export function setStatusBot(api: StatusBot): void {
  statusBot = api;
}

// Per-route last-activity timestamp. Populated from routeKey() on
// dispatch. initRouting seeds existing routes to "now" so we don't GC
// them in the first hour after a master restart (no history).
const routeActivity = new Map<string, number>();
function routeKey(chatId: string, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? ""}`;
}
function touchRoute(chatId: string, threadId: number | undefined): void {
  routeActivity.set(routeKey(chatId, threadId), Date.now());
}
// GC loop cadence. The outer interval (30s) reaps orphan containers —
// cheap, no Telegram calls. The dormancy threshold (2 min) controls how
// long a route has to be quiet before we probe its topic with
// sendChatAction (user sees "kackstein is typing…" for ~5s). Two minutes
// balances "detect deletions quickly" with "no typing-indicator spam in
// topics with occasional chat". Both overridable via env.
const GC_INTERVAL_MS = Number(process.env.WORKER_GC_INTERVAL_MS ?? "30000");
const GC_DORMANT_THRESHOLD_MS = Number(process.env.WORKER_GC_DORMANT_MS ?? "120000");

function reloadRoutes(): void {
  try {
    if (!existsSync(ROUTES_FILE)) {
      cachedRoutes = [];
      return;
    }
    const stat = statSync(ROUTES_FILE);
    if (stat.mtimeMs === lastMtime) return;
    lastMtime = stat.mtimeMs;
    const parsed = JSON.parse(readFileSync(ROUTES_FILE, "utf-8")) as RoutesFile;
    cachedRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];
    process.stderr.write(
      `telegram channel: routes reloaded — ${cachedRoutes.length} route(s)\n`,
    );
  } catch (err) {
    process.stderr.write(`telegram channel: routes.json parse error — ${err}\n`);
    cachedRoutes = [];
  }
}

export function initRouting(): void {
  reloadRoutes();
  watchFile(ROUTES_FILE, { interval: 1000, persistent: false }, reloadRoutes);
  // Grace period: seed all current routes as "active now" so the GC
  // doesn't immediately tear them down after a master restart (which
  // wiped the in-memory activity map).
  const now = Date.now();
  for (const r of cachedRoutes) routeActivity.set(routeKey(r.chat_id, r.thread_id), now);
  // Fire-and-forget GC loop. Only the master runs this — workers don't
  // import initRouting's caller path. Safe to schedule unconditionally.
  setInterval(() => {
    void gcLoop();
  }, GC_INTERVAL_MS);
}

/** Sync lookup — returns the cached route or undefined. */
export function findRoute(chatId: string, threadId: number | undefined): Route | undefined {
  if (threadId == null) return undefined;
  return cachedRoutes.find((r) => r.chat_id === chatId && r.thread_id === threadId);
}

/**
 * Sync-or-spawn: if no route exists for this (chat, topic) and thread_id is
 * set, spawn a new worker container, wait for it to be tmux-ready, and
 * append a route. DMs and the General topic (thread_id == null) are NOT
 * auto-routed — they stay on the master.
 *
 * Returns the route on success, or undefined if spawning failed or
 * thread_id was null.
 */
export async function resolveRoute(
  chatId: string,
  threadId: number | undefined,
): Promise<Route | undefined> {
  if (threadId == null) return undefined;
  const existing = findRoute(chatId, threadId);
  if (existing) {
    const state = await inspectContainer(existing.container);
    if (state === "running") return existing;

    // Container is down. If the topic-name cache now gives a prettier
    // name than what's in routes.json, drop the stale route + old
    // container and fall through to ensureWorker — which will spawn
    // with the correct name and re-emit the "new topic" status flow.
    const desired = deriveContainerName(chatId, threadId);
    if (desired !== existing.container) {
      process.stderr.write(
        `telegram channel: ${existing.container} down + better name "${desired}" available — reprovisioning\n`,
      );
      await runDocker(["rm", "-f", existing.container]);
      await removeRoute(existing);
      return ensureWorker(chatId, threadId);
    }

    // Same name — just respawn in place.
    const startedAt = Date.now();
    const msgId = await postStatus(
      chatId,
      threadId,
      `⚙️ Container "${existing.container}" war aus — starte neu…`,
    );
    const ready = await bringUpContainer(existing.container, chatId, threadId);
    if (!ready) {
      await editStatus(
        chatId,
        msgId,
        `❌ Respawn von "${existing.container}" fehlgeschlagen.`,
      );
      return undefined;
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    await postStatus(
      chatId,
      threadId,
      `✅ "${existing.container}" läuft wieder (${seconds}s).`,
    );
    return existing;
  }
  return ensureWorker(chatId, threadId);
}

// --- Spawn locking: one concurrent spawn per topic key ---
const spawningLocks = new Map<string, Promise<Route | undefined>>();

async function ensureWorker(chatId: string, threadId: number): Promise<Route | undefined> {
  const key = `${chatId}:${threadId}`;
  const inFlight = spawningLocks.get(key);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<Route | undefined> => {
    // Lock-holder re-checks in case reloadRoutes landed a concurrent edit.
    const raced = findRoute(chatId, threadId);
    if (raced) return raced;

    const container = deriveContainerName(chatId, threadId);
    process.stderr.write(
      `telegram channel: auto-spawning worker for chat=${chatId} topic=${threadId} → ${container}\n`,
    );

    // Post an in-topic status line so the human sees "something's
    // happening" while the container boots (takes ~15-25s cold). Edit
    // the same message on success/fail instead of spamming.
    const startedAt = Date.now();
    const statusMsgId = await postStatus(
      chatId,
      threadId,
      `⏳ Neuer Topic erkannt — Worker-Container "${container}" wird erstellt…`,
    );

    const ready = await bringUpContainer(container, chatId, threadId);
    if (!ready) {
      // Keep the ⏳ visible to show intent, add a second message with the
      // failure so Moritz can correlate. editStatus would hide the
      // "something was attempted" line.
      await editStatus(
        chatId,
        statusMsgId,
        `❌ Spawn fehlgeschlagen für "${container}". Prüfe Master-Logs.`,
      );
      return undefined;
    }

    const route: Route = {
      chat_id: chatId,
      thread_id: threadId,
      container,
      label: `auto-spawned ${new Date().toISOString().slice(0, 19)}`,
    };
    const written = await appendRoute(route);
    if (!written) {
      await editStatus(
        chatId,
        statusMsgId,
        `❌ Route konnte nicht in routes.json geschrieben werden. Container läuft, aber nicht gemappt.`,
      );
      return undefined;
    }

    // Keep the ⏳ message in place as a timeline marker, then post a
    // second "ready" message. Two messages > one edit because the user
    // sees the "it's happening" phase even when the boot is fast.
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    await postStatus(
      chatId,
      threadId,
      `✅ Worker "${container}" bereit (${seconds}s). Nachricht geht gleich ein.`,
    );

    // Post an overview of all active workers to the General thread so the
    // human can see the swarm grow/shrink at a glance.
    await postWorkerOverview(chatId, `+ ${container}`);

    process.stderr.write(
      `telegram channel: worker ${container} ready, route added for topic ${threadId}\n`,
    );
    return route;
  })();

  spawningLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    spawningLocks.delete(key);
  }
}

function deriveContainerName(chatId: string, threadId: number): string {
  const slug = loadTopicSlug(chatId, threadId);
  return slug ? `worker-${slug}-t${threadId}` : `worker-t${threadId}`;
}

function loadTopicSlug(chatId: string, threadId: number): string {
  try {
    if (!existsSync(TOPICS_CACHE_FILE)) return "";
    const cache = JSON.parse(readFileSync(TOPICS_CACHE_FILE, "utf-8")) as Record<string, { name?: string }>;
    const name = cache[`${chatId}:${threadId}`]?.name;
    return name ? slugify(name) : "";
  } catch {
    return "";
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/**
 * Persist a topic's name so the next spawn for that (chat, thread) uses
 * it in the container name. Called from server.ts's middleware when a
 * forum_topic_created or forum_topic_edited event comes through.
 */
export function rememberTopic(chatId: string, threadId: number, name: string): void {
  try {
    let cache: Record<string, { name: string }> = {};
    if (existsSync(TOPICS_CACHE_FILE)) {
      cache = JSON.parse(readFileSync(TOPICS_CACHE_FILE, "utf-8"));
    }
    cache[`${chatId}:${threadId}`] = { name };
    const tmp = `${TOPICS_CACHE_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(tmp, TOPICS_CACHE_FILE);
  } catch (err) {
    process.stderr.write(`telegram channel: topic cache write failed — ${err}\n`);
  }
}

async function postStatus(
  chatId: string,
  threadId: number,
  text: string,
): Promise<number | undefined> {
  if (!statusBot) return undefined;
  try {
    const sent = await statusBot.sendMessage(chatId, text, { message_thread_id: threadId });
    return sent.message_id;
  } catch (err) {
    process.stderr.write(`telegram channel: status post failed — ${err}\n`);
    return undefined;
  }
}

async function editStatus(chatId: string, msgId: number | undefined, text: string): Promise<void> {
  if (!statusBot || msgId == null) return;
  try {
    await statusBot.editMessageText(chatId, msgId, text);
  } catch (err) {
    process.stderr.write(`telegram channel: status edit failed — ${err}\n`);
  }
}

/**
 * Post a list of every active worker to the group's General thread so
 * the human keeps an overview of the swarm as topics are added/removed.
 * `change` is a short human-readable note like "+ worker-urlaub-t42" or
 * "− worker-xyz (topic deleted)".
 */
async function postWorkerOverview(chatId: string, change: string): Promise<void> {
  if (!statusBot) return;
  const lines = [`👥 Active workers (${cachedRoutes.length}) — ${change}`];
  for (const r of cachedRoutes) {
    if (r.chat_id !== chatId) continue; // stick to this chat's workers
    lines.push(`• topic ${r.thread_id} → ${r.container}`);
  }
  try {
    await statusBot.sendMessage(chatId, lines.join("\n"));
  } catch (err) {
    process.stderr.write(`telegram channel: overview post failed — ${err}\n`);
  }
}

// ── GC loop: tear down workers for topics the user deleted ────────────
// Runs on the master. For each route, if the topic has been dormant
// longer than the threshold, probe it with a cheap sendChatAction. If
// Telegram says "message thread not found", the topic is gone — stop
// and remove the container, drop the route from routes.json, delete the
// per-worker workspace dir. Active topics are skipped (touchRoute on
// every dispatch keeps them fresh).

async function gcLoop(): Promise<void> {
  if (!statusBot) return; // master hasn't wired us up yet
  // Phase A — probe every route's topic. Dead topic → teardown.
  const now = Date.now();
  const routes = [...cachedRoutes];
  for (const route of routes) {
    if (route.thread_id == null) continue;
    const last = routeActivity.get(routeKey(route.chat_id, route.thread_id)) ?? 0;
    if (now - last < GC_DORMANT_THRESHOLD_MS) continue;

    const alive = await probeTopicAlive(route.chat_id, route.thread_id);
    if (alive === true) {
      touchRoute(route.chat_id, route.thread_id);
      continue;
    }
    if (alive === "unknown") continue;

    process.stderr.write(
      `telegram channel: topic ${route.thread_id} in chat ${route.chat_id} gone — tearing down ${route.container}\n`,
    );
    await teardownWorker(route);
    await postWorkerOverview(route.chat_id, `− ${route.container} (topic deleted)`);
  }
  // Phase B — reap orphan containers. Any worker-t<N> container that
  // isn't in routes.json shouldn't exist. Covers: manual `docker rm`
  // of a route without route-edit, failed-midway spawns, routes.json
  // edited by hand, or old containers surviving a master wipe.
  await reapOrphanContainers();
}

async function reapOrphanContainers(): Promise<void> {
  const { code, stdout } = await runDockerWithOutput([
    "ps",
    "-a",
    "--filter",
    "name=worker-t",
    "--format",
    "{{.Names}}",
  ]);
  if (code !== 0) return;
  const names = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("worker-t"));
  if (names.length === 0) return;
  const known = new Set(cachedRoutes.map((r) => r.container));
  for (const name of names) {
    if (known.has(name)) continue;
    process.stderr.write(
      `telegram channel: orphan container ${name} (not in routes.json) — removing\n`,
    );
    await runDocker(["rm", "-f", name]);
    if (WORKER_HOST_BASE_DIR) {
      await runDocker([
        "run",
        "--rm",
        "-v",
        `${WORKER_HOST_BASE_DIR}:/host`,
        "alpine",
        "sh",
        "-c",
        `rm -rf /host/workers/${name}`,
      ]);
    }
  }
}

async function probeTopicAlive(
  chatId: string,
  threadId: number,
): Promise<true | false | "unknown"> {
  if (!statusBot) return "unknown";
  try {
    await statusBot.sendChatAction(chatId, "typing", { message_thread_id: threadId });
    return true;
  } catch (err) {
    const msg = String(err).toLowerCase();
    if (msg.includes("thread not found") || msg.includes("topic_deleted") || msg.includes("topic_closed")) {
      return false;
    }
    // Any other error (network hiccup, rate limit, chat kicked us) —
    // stay conservative and keep the route.
    process.stderr.write(`telegram channel: probe inconclusive (${msg.slice(0, 120)})\n`);
    return "unknown";
  }
}

async function teardownWorker(route: Route): Promise<void> {
  // Stop + remove the container. `rm -f` also stops.
  await runDocker(["rm", "-f", route.container]);
  // Remove the route from routes.json.
  await removeRoute(route);
  // Remove the per-worker workspace dir on the host — done via a
  // throwaway alpine container because the master doesn't have direct
  // filesystem access to the host mount root.
  if (WORKER_HOST_BASE_DIR) {
    await runDocker([
      "run",
      "--rm",
      "-v",
      `${WORKER_HOST_BASE_DIR}:/host`,
      "alpine",
      "sh",
      "-c",
      `rm -rf /host/workers/${route.container}`,
    ]);
  }
  routeActivity.delete(routeKey(route.chat_id, route.thread_id));
}

async function removeRoute(target: Route): Promise<boolean> {
  try {
    let current: RoutesFile = { routes: [] };
    if (existsSync(ROUTES_FILE)) {
      current = JSON.parse(readFileSync(ROUTES_FILE, "utf-8")) as RoutesFile;
    }
    const routes = (current.routes ?? []).filter(
      (r) => !(r.chat_id === target.chat_id && r.thread_id === target.thread_id),
    );
    const tmp = `${ROUTES_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify({ routes }, null, 2)}\n`);
    renameSync(tmp, ROUTES_FILE);
    cachedRoutes = routes;
    lastMtime = statSync(ROUTES_FILE).mtimeMs;
    return true;
  } catch (err) {
    process.stderr.write(`telegram channel: routes.json remove failed — ${err}\n`);
    return false;
  }
}

/**
 * Ensure the named container exists, is running, and has a `claude` tmux
 * session. Reuses a stopped container (docker start) before creating a
 * new one (docker run).
 */
async function bringUpContainer(
  container: string,
  chatId: string,
  threadId: number,
): Promise<boolean> {
  const state = await inspectContainer(container);
  if (state === "running") {
    return waitForTmuxReady(container);
  }
  if (state === "exited") {
    const started = await runDocker(["start", container]);
    if (!started) return false;
    return waitForTmuxReady(container);
  }
  // not-found — docker run
  if (!WORKER_HOST_BASE_DIR) {
    process.stderr.write(
      "telegram channel: WORKER_HOST_BASE_DIR not set — cannot spawn new workers. Set it in the master compose.\n",
    );
    return false;
  }
  const spawned = await dockerRun(container, chatId, threadId);
  if (!spawned) return false;
  return waitForTmuxReady(container);
}

async function inspectContainer(name: string): Promise<"running" | "exited" | "not-found"> {
  const { code, stdout } = await runDockerWithOutput([
    "inspect",
    "-f",
    "{{.State.Status}}",
    name,
  ]);
  if (code !== 0) return "not-found";
  const status = stdout.trim();
  if (status === "running") return "running";
  return "exited";
}

async function dockerRun(container: string, chatId: string, threadId: number): Promise<boolean> {
  const workspaceHost = join(WORKER_HOST_BASE_DIR, "workers", container, "workspace");
  const claudeHost = join(WORKER_HOST_BASE_DIR, "root_claude");
  const claudeJsonHost = join(WORKER_HOST_BASE_DIR, "root_claude.json");

  // Ensure the per-worker workspace dir exists on the host before docker
  // creates the bind mount. A one-shot container runs mkdir via a volume
  // mount of the base dir — tiny image, disposable.
  const mkdirOk = await runDocker([
    "run",
    "--rm",
    "-v",
    `${WORKER_HOST_BASE_DIR}:/host`,
    "alpine",
    "sh",
    "-c",
    `mkdir -p /host/workers/${container}/workspace`,
  ]);
  if (!mkdirOk) {
    process.stderr.write(
      `telegram channel: could not create workspace dir for ${container}\n`,
    );
    return false;
  }

  const args = [
    "run",
    "-d",
    // -t allocates a pseudo-TTY. The worker entrypoint ends with
    // `exec tmux attach` which fails with "not a terminal" without this.
    "-t",
    "--name",
    container,
    "--restart",
    "unless-stopped",
    "--env-file",
    WORKER_SECRETS_ENV,
    "-e",
    `TELEGRAM_DEFAULT_CHAT_ID=${chatId}`,
    "-e",
    `TELEGRAM_DEFAULT_THREAD_ID=${threadId}`,
    "-e",
    `TELEGRAM_ROLE=worker`,
    "-e",
    "TZ=Europe/Berlin",
    ...(WORKER_INIT_SCRIPT ? ["-e", `WORKER_INIT_SCRIPT=${WORKER_INIT_SCRIPT}`] : []),
    "-v",
    `${claudeHost}:/root/.claude`,
    "-v",
    `${claudeJsonHost}:/root/.claude.json`,
    "-v",
    `${workspaceHost}:/workspace`,
    ...parseExtraMounts(WORKER_EXTRA_MOUNTS),
    WORKER_IMAGE,
  ];
  return runDocker(args, SPAWN_TIMEOUT_MS);
}

async function waitForTmuxReady(container: string): Promise<boolean> {
  const deadline = Date.now() + TMUX_READY_TIMEOUT_MS;
  let sessionUp = false;
  while (Date.now() < deadline) {
    if (!sessionUp) {
      const ok = await runDocker([
        "exec",
        container,
        "tmux",
        "has-session",
        "-t",
        TMUX_SESSION,
      ]);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      sessionUp = true;
    }
    // Session exists — now wait for Claude's input prompt to be reachable,
    // so a C-m submit isn't lost into the booting TUI. We look for the
    // "❯ " chevron that precedes the input box.
    const { code, stdout } = await runDockerWithOutput([
      "exec",
      container,
      "tmux",
      "capture-pane",
      "-t",
      TMUX_SESSION,
      "-p",
    ]);
    if (code === 0 && stdout.includes("❯")) {
      // The chevron is visible the moment the TUI renders, but the
      // TUI's key handler may still be wiring up. A small grace gives
      // the first dispatch's C-m a chance of landing.
      await new Promise((r) => setTimeout(r, 2_000));
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stderr.write(
    `telegram channel: ${container} never reached Claude prompt within ${TMUX_READY_TIMEOUT_MS}ms\n`,
  );
  return false;
}

/** Atomic append to routes.json: write tmp + rename. */
async function appendRoute(newRoute: Route): Promise<boolean> {
  try {
    let current: RoutesFile = { routes: [] };
    if (existsSync(ROUTES_FILE)) {
      current = JSON.parse(readFileSync(ROUTES_FILE, "utf-8")) as RoutesFile;
    }
    const routes = current.routes ?? [];
    const duplicate = routes.some(
      (r) => r.chat_id === newRoute.chat_id && r.thread_id === newRoute.thread_id,
    );
    if (!duplicate) routes.push(newRoute);

    const tmp = `${ROUTES_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify({ routes }, null, 2)}\n`);
    renameSync(tmp, ROUTES_FILE);

    // Refresh in-memory cache immediately; don't wait for the watch tick.
    cachedRoutes = routes;
    lastMtime = statSync(ROUTES_FILE).mtimeMs;
    return true;
  } catch (err) {
    process.stderr.write(`telegram channel: routes.json append failed — ${err}\n`);
    return false;
  }
}

/**
 * Inject an inbound message into a worker's tmux-hosted claude session.
 *
 * Two passes, with a small delay between them:
 *  1. `send-keys -l --` pastes the raw text literally (no tmux key-spec
 *     interpretation — dashes, `C-x`, `M-y`, etc. inside the user's
 *     content stay as characters).
 *  2. `send-keys C-m` fires the submit. Claude Code's TUI treats plain
 *     `Enter` (CR+LF) as "insert newline"; only bare `C-m` submits.
 */
export async function dispatchToWorker(
  route: Route,
  payload: { content: string; meta: Record<string, string | undefined> },
): Promise<boolean> {
  // Mark this route as active so the GC loop doesn't try to probe it.
  touchRoute(route.chat_id, route.thread_id);
  const line = formatForInjection(payload);
  const paste = await runDocker([
    "exec",
    route.container,
    "tmux",
    "send-keys",
    "-t",
    TMUX_SESSION,
    "-l",
    "--",
    line,
  ]);
  if (!paste) return false;
  await new Promise((r) => setTimeout(r, 150));
  const submit = await runDocker([
    "exec",
    route.container,
    "tmux",
    "send-keys",
    "-t",
    TMUX_SESSION,
    "C-m",
  ]);
  if (!submit) return false;
  // Retry-submit after 1s: a freshly-booted Claude TUI occasionally
  // drops the first C-m while its key handler is warming up. An extra
  // C-m is harmless when the prompt is already empty — the TUI just
  // treats it as a no-op empty submit.
  await new Promise((r) => setTimeout(r, 1_000));
  await runDocker([
    "exec",
    route.container,
    "tmux",
    "send-keys",
    "-t",
    TMUX_SESSION,
    "C-m",
  ]);
  return true;
}

function formatForInjection(payload: {
  content: string;
  meta: Record<string, string | undefined>;
}): string {
  const m = payload.meta;
  const header: string[] = [];
  if (m.user) header.push(`@${m.user}`);
  if (m.chat_id) header.push(`chat ${m.chat_id}`);
  if (m.thread_id) header.push(`topic ${m.thread_id}`);
  if (m.message_id) header.push(`msg ${m.message_id}`);
  const headerStr = header.length ? `[Telegram ${header.join(" ")}]` : "[Telegram]";
  const flat = payload.content.replace(/\r?\n/g, " ⏎ ");
  return `${headerStr} ${flat}`;
}

function runDocker(args: string[], timeoutMs: number = DISPATCH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      process.stderr.write(
        `telegram channel: docker ${args.slice(0, 3).join(" ")}… timed out after ${timeoutMs}ms\n`,
      );
      resolve(false);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        process.stderr.write(
          `telegram channel: docker ${args.slice(0, 3).join(" ")}… exit ${code}: ${stderr.trim()}\n`,
        );
        resolve(false);
        return;
      }
      resolve(true);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      process.stderr.write(`telegram channel: docker spawn failed — ${err}\n`);
      resolve(false);
    });
  });
}

function runDockerWithOutput(
  args: string[],
  timeoutMs: number = DISPATCH_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: `${stderr}\n(timeout)` });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err}` });
    });
  });
}
