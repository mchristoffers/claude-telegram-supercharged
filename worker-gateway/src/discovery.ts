import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import Docker from "dockerode";

export type Worker = {
  container: string;
  chatId: string;
  threadId: number;
  topic: string | null;
  label: string;
  status: string;
  ip: string | null;
};

type RoutesFile = {
  routes: Array<{
    chat_id: string;
    thread_id: number;
    container: string;
    label?: string;
  }>;
};

type TopicsFile = Record<string, { name?: string }>;

const ROUTES_FILE = process.env.ROUTES_FILE ?? "/state/routes.json";
const TOPICS_FILE = process.env.TOPICS_FILE ?? "/state/topics.json";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

async function readJSON<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function resolveIP(containerName: string): Promise<string | null> {
  try {
    const info = await docker.getContainer(containerName).inspect();
    const networks = info.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(networks)) {
      const ip = (net as { IPAddress?: string })?.IPAddress;
      if (ip) return ip;
    }
  } catch {
    // container gone or no access
  }
  return null;
}

export async function liveWorkers(): Promise<Worker[]> {
  const [routes, topics] = await Promise.all([
    readJSON<RoutesFile>(ROUTES_FILE),
    readJSON<TopicsFile>(TOPICS_FILE),
  ]);

  if (!routes?.routes?.length) return [];

  const running = new Set<string>();
  const statusByName = new Map<string, string>();
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      for (const n of c.Names) {
        const name = n.replace(/^\//, "");
        running.add(name);
        statusByName.set(name, c.State);
      }
    }
  } catch (err) {
    console.error("dockerode listContainers failed:", err);
  }

  const workers: Worker[] = [];
  for (const r of routes.routes) {
    if (!running.has(r.container)) continue;
    const key = `${r.chat_id}:${r.thread_id}`;
    const topic = topics?.[key]?.name ?? null;
    const ip = await resolveIP(r.container);
    workers.push({
      container: r.container,
      chatId: r.chat_id,
      threadId: r.thread_id,
      topic,
      label: r.label ?? "",
      status: statusByName.get(r.container) ?? "unknown",
      ip,
    });
  }
  return workers;
}

export async function isKnownWorker(container: string): Promise<boolean> {
  const routes = await readJSON<RoutesFile>(ROUTES_FILE);
  return !!routes?.routes?.some((r) => r.container === container);
}

type Listener = () => void;
const listeners = new Set<Listener>();

let routesMtime = 0;
async function pollMtime() {
  try {
    const s = await stat(ROUTES_FILE);
    const m = s.mtimeMs;
    if (m !== routesMtime) {
      routesMtime = m;
      for (const fn of listeners) fn();
    }
  } catch {
    // file may not exist yet
  }
}

export function startWatcher() {
  pollMtime();
  try {
    watch(ROUTES_FILE, { persistent: false }, () => pollMtime());
  } catch {
    // fall back to interval-only if watch fails (e.g. mount doesn't support inotify)
  }
  setInterval(pollMtime, 2000);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
