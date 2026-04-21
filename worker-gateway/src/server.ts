import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFile } from "node:fs/promises";
import Docker from "dockerode";
import {
  liveWorkers,
  isKnownWorker,
  startWatcher,
  subscribe,
  type Worker,
} from "./discovery.ts";
import { notify, md2, notifyEnabled } from "./notify.ts";

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL ?? "";
const DISABLE_ACCESS_CHECK = process.env.DISABLE_ACCESS_CHECK === "1";
const PORT = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8090);
const VNC_PORT = Number(process.env.VNC_PORT ?? 5900);
const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;

const app = new Hono();

app.use("*", async (c, next) => {
  const path = c.req.path;
  if (path === "/healthz") return next();
  if (DISABLE_ACCESS_CHECK) return next();

  const email = c.req.header("Cf-Access-Authenticated-User-Email");
  if (!email) return c.text("unauthenticated — CF Access header missing", 401);
  if (ALLOWED_EMAIL && email !== ALLOWED_EMAIL) {
    return c.text(`forbidden for ${email}`, 403);
  }
  return next();
});

app.get("/healthz", (c) => c.text("ok"));

app.get("/api/workers", async (c) => {
  const workers = await liveWorkers();
  return c.json({ workers });
});

app.get("/api/stream", (c) => {
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = async () => {
          try {
            const workers = await liveWorkers();
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ workers })}\n\n`),
            );
          } catch (err) {
            console.error("SSE send failed:", err);
          }
        };
        await send();
        const unsub = subscribe(send);
        const interval = setInterval(send, 5000);
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(interval);
          unsub();
          try {
            controller.close();
          } catch {}
        });
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});

app.get("/", async (c) => {
  const html = await readFile(`${PUBLIC_DIR}/panel.html`, "utf-8");
  return c.html(html);
});

app.get("/vnc/:container", async (c) => {
  const container = c.req.param("container");
  if (!(await isKnownWorker(container))) {
    return c.text("unknown worker", 404);
  }
  const html = await readFile(`${PUBLIC_DIR}/vnc-embed.html`, "utf-8");
  return c.html(html.replace(/__CONTAINER__/g, container));
});

app.get("/novnc/*", serveStatic({ root: "./public" }));
app.get("/vue.esm-browser.prod.js", serveStatic({ path: "./public/vue.esm-browser.prod.js" }));

type BridgeWs = {
  container: string;
  tcp?: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never;
  pingTimer?: ReturnType<typeof setInterval>;
};

const server = Bun.serve<BridgeWs>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/ws\/([\w-]+)$/);
    if (wsMatch) {
      const container = wsMatch[1]!;

      if (!DISABLE_ACCESS_CHECK) {
        const email = req.headers.get("Cf-Access-Authenticated-User-Email");
        if (!email || (ALLOWED_EMAIL && email !== ALLOWED_EMAIL)) {
          return new Response("forbidden", { status: 403 });
        }
      }

      if (!(await isKnownWorker(container))) {
        return new Response("unknown worker", { status: 404 });
      }

      const upgraded = srv.upgrade(req, { data: { container } });
      if (upgraded) return undefined;
      return new Response("ws upgrade failed", { status: 500 });
    }

    return app.fetch(req);
  },
  websocket: {
    // binary WS frames, RFB-protocol payload
    async open(ws) {
      const container = ws.data.container;
      console.log(`ws open → ${container}`);

      const info = await (async () => {
        try {
          const { default: Docker } = await import("dockerode");
          const docker = new Docker({ socketPath: "/var/run/docker.sock" });
          return await docker.getContainer(container).inspect();
        } catch (err) {
          console.error("inspect failed", err);
          return null;
        }
      })();
      const networks = info?.NetworkSettings?.Networks ?? {};
      let ip: string | null = null;
      for (const net of Object.values(networks)) {
        const i = (net as { IPAddress?: string }).IPAddress;
        if (i) {
          ip = i;
          break;
        }
      }
      if (!ip) {
        console.error(`no IP for ${container}`);
        ws.close(1011, "no IP");
        return;
      }

      try {
        const tcp = await Bun.connect({
          hostname: ip,
          port: VNC_PORT,
          socket: {
            data(_socket, data) {
              ws.sendBinary(data);
            },
            close() {
              try {
                ws.close(1000, "vnc closed");
              } catch {}
            },
            error(_socket, err) {
              console.error(`tcp error ${container}:`, err);
              try {
                ws.close(1011, "vnc error");
              } catch {}
            },
          },
        });
        ws.data.tcp = tcp;
      } catch (err) {
        console.error(`tcp connect ${ip}:${VNC_PORT} failed:`, err);
        ws.close(1011, "tcp connect failed");
        return;
      }

      ws.data.pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {}
      }, 30_000);
    },
    message(ws, data) {
      const tcp = ws.data.tcp;
      if (!tcp) return;
      if (typeof data === "string") tcp.write(data);
      else tcp.write(data);
    },
    close(ws) {
      if (ws.data.pingTimer) clearInterval(ws.data.pingTimer);
      try {
        ws.data.tcp?.end();
      } catch {}
      console.log(`ws close ← ${ws.data.container}`);
    },
  },
});

startWatcher();

// Docker events → Telegram. Fires when any of *this master's* worker-*
// containers is destroyed (manual rm, gc, compose down, crash + restart
// policy exhausted, …) or dies with non-zero exit. One event per action,
// so no dedupe needed.
//
// Scoping: events are filtered to the docker label
// `supercharged-pool=<WORKER_POOL>`, so masters sharing the host docker
// socket don't announce each other's worker deaths. WORKER_POOL defaults
// to the basename of WORKER_HOST_BASE_DIR (already unique per bot); each
// worker gets the matching label at spawn time from routing.ts. If the
// pool can't be determined we disable notifications entirely — better to
// go quiet than to spam the wrong chat.
const WORKER_HOST_BASE_DIR = process.env.WORKER_HOST_BASE_DIR ?? "";
const WORKER_POOL =
  process.env.WORKER_POOL ??
  (WORKER_HOST_BASE_DIR
    ? WORKER_HOST_BASE_DIR.split("/").filter(Boolean).pop() ?? ""
    : "");
(async () => {
  if (!notifyEnabled()) {
    console.log("notify: disabled (TELEGRAM_BOT_TOKEN or NOTIFY_CHAT_ID unset)");
    return;
  }
  if (!WORKER_POOL) {
    console.log(
      "notify: disabled (WORKER_POOL unset and can't derive from WORKER_HOST_BASE_DIR; refusing to broadcast other masters' worker events)",
    );
    return;
  }
  const poolLabel = `supercharged-pool=${WORKER_POOL}`;
  const dockerEvents = new Docker({ socketPath: "/var/run/docker.sock" });
  const stream = await dockerEvents.getEvents({
    filters: JSON.stringify({
      type: ["container"],
      event: ["destroy", "die"],
      label: [poolLabel],
    }),
  });
  stream.on("data", async (chunk: Buffer) => {
    let evt: {
      Action?: string;
      Actor?: { Attributes?: { name?: string; exitCode?: string; [k: string]: string | undefined } };
    };
    try {
      evt = JSON.parse(chunk.toString());
    } catch {
      return;
    }
    const name = evt.Actor?.Attributes?.name;
    if (!name || !name.startsWith("worker-")) return;
    // Defense in depth: the event-stream filter should already guarantee
    // this, but if an older worker was spawned before labelling was wired
    // up its label is missing — skip it quietly rather than notify.
    const eventPool = evt.Actor?.Attributes?.["supercharged-pool"];
    if (eventPool !== WORKER_POOL) return;
    console.log(`notify: ${evt.Action} ${name} (pool=${eventPool})`);

    if (evt.Action === "destroy") {
      await notify(`🗑️ Worker\\-Container entfernt: \`${md2(name)}\``);
    } else if (evt.Action === "die") {
      const code = evt.Actor?.Attributes?.exitCode ?? "?";
      // Skip exit 0 — clean stops are followed by destroy and would double-notify.
      if (code !== "0") {
        await notify(`⚠️ Worker\\-Container gestorben: \`${md2(name)}\` \\(exit ${md2(code)}\\)`);
      }
    }
  });
  stream.on("error", (err: Error) => console.error("docker events stream:", err));
  console.log(`notify: docker events listener active (pool=${WORKER_POOL})`);
})().catch((err) => console.error("notify init failed:", err));

console.log(`worker-gateway listening on :${server.port}`);
