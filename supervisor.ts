#!/usr/bin/env bun
/**
 * Supervisor for Claude Code with Telegram channel.
 *
 * Spawns claude with --channels, watches for a restart signal file written
 * by the Telegram MCP server when the user requests a full context reset,
 * then kills and restarts the claude process for a fresh session.
 *
 * Signal file: ~/.claude/channels/telegram/data/restart.signal
 *
 * Usage:
 *   bun supervisor.ts [extra claude flags...]
 *   bun supervisor.ts --dangerously-skip-permissions
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".claude", "channels", "telegram");
const DATA_DIR = join(STATE_DIR, "data");
const SIGNAL_FILE = join(DATA_DIR, "restart.signal");
const CLAUDE_CMD = "claude";
// Router model: configurable via TELEGRAM_ROUTER_MODEL env var.
// Options: "haiku" (fast, 200K context), "sonnet" (balanced, 1M context), "opus" (deep, 1M context)
// Default: "haiku" — fast first-touch; the router hands heavy work to Opus subagents.
const ROUTER_MODEL = process.env.TELEGRAM_ROUTER_MODEL || "haiku";
const BASE_ARGS = [
	"--channels",
	"plugin:telegram@claude-plugins-official",
	"--dangerously-skip-permissions",
	"--model",
	ROUTER_MODEL,
];

// Extra args passed to this supervisor are forwarded to claude
const EXTRA_ARGS = process.argv.slice(2);

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;
const GRACEFUL_TIMEOUT_MS = 5_000;
const CONTEXT_CHECK_INTERVAL_MS = 30_000; // Check context every 30s
const CONTEXT_THRESHOLD_PCT = 50; // Auto-restart when context exceeds 50% — keeps sessions fresh
const MAX_SESSION_UPTIME_MS = 2 * 60 * 60 * 1000; // Force restart after 2 hours regardless of context
const STDOUT_LOG = join(DATA_DIR, "supervisor-stdout.log");
// Auth-error backoff: when Claude's stdout shows "Please run /login" or
// an authentication_error, the refresh endpoint is likely rate-limited.
// Continuing to respawn Claude just deepens the rate-limit window.
// Sit still for AUTH_BACKOFF_MS so the window clears, then try again.
const AUTH_BACKOFF_MS = 20 * 60 * 1000;
const AUTH_CHECK_INTERVAL_MS = 15_000;
const AUTH_ERROR_PATTERNS = [
	/Please run \/login/i,
	/authentication_error/i,
	/Invalid authentication credentials/i,
];
// Proactive OAuth token refresh — prevents Claude from ever hitting a 401.
// Daemon context amplifies reactive refresh (Claude-on-401) into retry
// storms that rate-limit the per-IP /v1/oauth/token endpoint, which
// manifests as bogus "/login" prompts even on still-valid tokens.
const CREDS_FILE = join(homedir(), ".claude", ".credentials.json");
const OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_MAX_INTERVAL_MS = 4 * 60 * 60 * 1000; // cap at 4h
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // floor at 5min (on failure)
const REFRESH_SAFETY_MARGIN_MS = 10 * 60 * 1000; // aim to refresh this long before expiry
// Delay before restart to let Claude finish sending Telegram replies
const RESTART_DELAY_MS = 3_000;

let currentChild: ChildProcess | null = null;
let restartCount = 0;
let lastStartTime = 0;
let shuttingDown = false;
let pendingRestart = false;
let authBackoffUntil = 0;
let lastAuthTrigger = 0;
let authScanCursor = 0; // byte offset — skip log content we've already evaluated
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveRefreshFails = 0;

function log(msg: string): void {
	process.stderr.write(
		`[supervisor ${new Date().toISOString()}] ${msg}\n`,
	);
}

function backoffMs(): number {
	const b = BACKOFF_BASE_MS * 2 ** Math.min(restartCount, 5);
	return Math.min(b, BACKOFF_MAX_MS);
}

async function killProcessTree(pid: number, signal: string): Promise<void> {
	try {
		// Kill the entire process group (negative PID)
		process.kill(-pid, signal);
	} catch {
		// If process group kill fails, fall back to direct kill
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

async function killChild(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode !== null) return;

	const pid = child.pid;
	log(`killing process tree (pid=${pid})`);

	// Send SIGTERM to the entire process group
	await killProcessTree(pid, "SIGTERM");

	await new Promise<void>((resolve) => {
		const deadline = setTimeout(() => {
			if (child.exitCode === null) {
				log("graceful timeout — sending SIGKILL to process tree");
				void killProcessTree(pid, "SIGKILL");
			}
			resolve();
		}, GRACEFUL_TIMEOUT_MS);

		child.once("exit", () => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

async function startClaude(): Promise<void> {
	if (shuttingDown) return;

	// If we're still in auth backoff, defer the spawn. The refresh endpoint
	// is almost certainly rate-limited per-IP; respawning now would just
	// extend the window.
	const now = Date.now();
	if (authBackoffUntil > now) {
		const waitMs = authBackoffUntil - now;
		log(`auth backoff active — deferring spawn by ${Math.round(waitMs / 1000)}s`);
		setTimeout(startClaude, waitMs);
		return;
	}

	// Kill any orphaned claude + MCP server processes before spawning fresh.
	await cleanupOrphans();

	// Brute-force kill any remaining bun server.ts (MCP) processes that
	// slipped past cleanupOrphans (different process-tree ancestry).
	try {
		const { execSync } = await import("node:child_process");
		execSync(
			"pkill -9 -f 'bun server.ts' || true; pkill -9 -f 'bun run.*--silent start' || true",
			{ encoding: "utf-8" },
		);
	} catch {}

	const uptime = Date.now() - lastStartTime;
	if (lastStartTime > 0 && uptime > STABLE_UPTIME_MS) {
		restartCount = 0;
	}

	lastStartTime = Date.now();
	const args = [...BASE_ARGS, ...EXTRA_ARGS];
	log(`spawning: ${CLAUDE_CMD} ${args.join(" ")}`);
	// Use `expect` wrapper to allocate a PTY and auto-accept the workspace trust dialog.
	// expect spawns Claude with a pseudo-TTY (so it enters interactive mode under launchd)
	// and auto-sends Enter when it sees the "trust this folder" prompt.
	const EXPECT_WRAPPER = join(homedir(), ".claude", "scripts", "claude-daemon-wrapper.exp");
	const child = spawn(EXPECT_WRAPPER, args, {
		stdio: "inherit",
		env: { ...process.env },
		detached: true, // Create a new process group so we can kill the entire tree
	});
	// Despite detached:true, we still want the child to die with the supervisor.
	// unref() is NOT called — the supervisor event loop keeps running.
	currentChild = child;

	child.on("exit", (code, signal) => {
		currentChild = null;
		if (shuttingDown) return;

		if (pendingRestart) {
			// Restart triggered by signal file — restart immediately
			pendingRestart = false;
			restartCount = 0;
			log("context reset complete — waiting for sub-processes to release connections...");
			setTimeout(startClaude, 2000);
		} else if (code === 0) {
			// Clean exit — user typed /exit or similar
			log("claude exited cleanly (code=0) — restarting after cleanup delay");
			restartCount = 0;
			setTimeout(startClaude, 2000);
		} else {
			// Crash — apply backoff
			restartCount++;
			const delay = backoffMs();
			log(
				`claude crashed (code=${code}, signal=${signal}) — restart #${restartCount} in ${delay}ms`,
			);
			setTimeout(startClaude, delay);
		}
	});

	child.on("error", (err) => {
		log(`failed to spawn claude: ${err.message}`);
		currentChild = null;
		restartCount++;
		const delay = backoffMs();
		setTimeout(startClaude, delay);
	});
}

async function handleRestartSignal(): Promise<void> {
	if (!existsSync(SIGNAL_FILE)) return;
	if (pendingRestart) return; // already handling one

	log("restart signal detected");

	// Read optional delay-until timestamp from the file
	let delayMs = RESTART_DELAY_MS;
	try {
		const content = readFileSync(SIGNAL_FILE, "utf-8").trim();
		const until = Number.parseInt(content, 10);
		if (!Number.isNaN(until) && until > Date.now()) {
			delayMs = until - Date.now();
		}
	} catch {}

	// Consume the signal file immediately
	try {
		rmSync(SIGNAL_FILE, { force: true });
	} catch (err) {
		log(`warning: could not remove signal file: ${err}`);
	}

	log(`waiting ${delayMs}ms for Claude to finish sending replies...`);
	await new Promise((r) => setTimeout(r, delayMs));

	if (currentChild) {
		pendingRestart = true;
		log("terminating current claude session for context reset");
		await killChild(currentChild);
		// The exit handler will detect pendingRestart and call startClaude
	} else {
		log("no running claude process — starting fresh");
		startClaude();
	}
}

function startWatching(): void {
	mkdirSync(DATA_DIR, { recursive: true });

	// fs.watchFile polls reliably on macOS and Linux
	watchFile(SIGNAL_FILE, { interval: 500, persistent: true }, (curr) => {
		if (curr.mtimeMs > 0) {
			void handleRestartSignal();
		}
	});

	log(`watching for restart signal at: ${SIGNAL_FILE}`);
}

// Graceful shutdown of the supervisor itself
async function shutdown(sig: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`received ${sig} — shutting down`);

	unwatchFile(SIGNAL_FILE);

	if (currentChild) {
		await killChild(currentChild);
	}
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Kill any orphaned claude + bun server.ts (MCP) processes from previous runs
async function cleanupOrphans(): Promise<void> {
	const { execSync } = await import("node:child_process");
	try {
		const myPid = process.pid;

		// Hunt for both orphaned Claude sessions AND stale MCP server processes.
		// Stale bun server.ts holds the Telegram-daemon sqlite lock + telegram.lock,
		// so the next supervisor start crashes unless we reap them first.
		const patterns = [
			"claude.*--channels.*telegram",
			"bun server\\.ts",
			"bun run.*--silent start",
		];
		const allPids: number[] = [];

		for (const pattern of patterns) {
			const result = execSync(`pgrep -f '${pattern}' || true`, {
				encoding: "utf-8",
			}).trim();
			if (!result) continue;
			const pids = result
				.split("\n")
				.map((p) => Number.parseInt(p.trim(), 10))
				.filter((p) => !Number.isNaN(p) && p !== myPid);
			allPids.push(...pids);
		}

		if (allPids.length === 0) return;
		const uniquePids = [...new Set(allPids)];

		// Filter out interactive sessions (processes with a TTY are user terminals)
		const orphanPids: number[] = [];
		for (const pid of uniquePids) {
			try {
				const tty = execSync(`ps -p ${pid} -o tty=`, {
					encoding: "utf-8",
				}).trim();
				if (tty && tty !== "??" && tty !== "") {
					log(`skipping pid=${pid} (interactive session on ${tty})`);
					continue;
				}
			} catch {
				// ps failed — process may already be dead, skip it
				continue;
			}
			orphanPids.push(pid);
		}

		for (const pid of orphanPids) {
			log(`killing orphaned process pid=${pid}`);
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}

		if (orphanPids.length > 0) {
			// Give them time to die
			await new Promise((r) => setTimeout(r, 2000));
			// Force kill any survivors
			for (const pid of orphanPids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {} // already dead — fine
			}
		}
	} catch (err) {
		log(`orphan cleanup warning: ${err}`);
	}
}

// ── Context watchdog ──────────────────────────────────────────────
// Monitors the stdout log for context usage percentage.
// When it exceeds CONTEXT_THRESHOLD_PCT, triggers a graceful restart
// to prevent the session from becoming unresponsive.

let contextWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastWatchdogTrigger = 0;

function startContextWatchdog(): void {
	if (contextWatchdogTimer) return;
	contextWatchdogTimer = setInterval(() => {
		if (!currentChild || shuttingDown) return;
		// Debounce: don't trigger more than once per 60 seconds
		if (Date.now() - lastWatchdogTrigger < 60_000) return;
		try {
			// Check 1: session running too long (prevents dormancy bug).
			// Runs FIRST and independently of log parsing — the age-based cap must fire
			// even when the stdout log is unparseable (e.g. PTY ANSI escapes swallow the
			// status bar rendering, which is how a 7-day dormant session slipped past).
			const uptime = Date.now() - lastStartTime;
			if (uptime > MAX_SESSION_UPTIME_MS) {
				log(`context watchdog: session uptime ${Math.round(uptime / 60000)}min exceeds max ${Math.round(MAX_SESSION_UPTIME_MS / 60000)}min — triggering restart`);
				lastWatchdogTrigger = Date.now();
				mkdirSync(join(SIGNAL_FILE, ".."), { recursive: true });
				writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
				return;
			}

			// Read the last 2KB of the stdout log to find the context percentage
			const stat = statSync(STDOUT_LOG);
			const readSize = Math.min(stat.size, 2048);
			const fd = openSync(STDOUT_LOG, "r");
			const buf = Buffer.alloc(readSize);
			readSync(fd, buf, 0, readSize, stat.size - readSize);
			closeSync(fd);
			const tail = buf.toString("utf-8");

			// Match the status bar pattern: ░█ blocks followed by percentage
			// This avoids false positives from message content like "I'm 85% sure"
			const matches = [...tail.matchAll(/[█░]+\s+(\d{1,3})%/g)];
			if (matches.length === 0) return;

			// Take the last percentage found (most recent status bar)
			const lastPct = Number.parseInt(matches[matches.length - 1][1], 10);

			// Check 2: context too high
			if (lastPct >= CONTEXT_THRESHOLD_PCT && lastPct <= 100) {
				log(`context watchdog: usage at ${lastPct}% (threshold: ${CONTEXT_THRESHOLD_PCT}%) — triggering restart`);
				lastWatchdogTrigger = Date.now();
				mkdirSync(join(SIGNAL_FILE, ".."), { recursive: true });
				writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
				return;
			}
		} catch {
			// Ignore read errors — file might not exist yet
		}
	}, CONTEXT_CHECK_INTERVAL_MS);
}

// ── Auth watchdog ─────────────────────────────────────────────────
// Scans the stdout log for auth errors ("Please run /login",
// authentication_error, 401). When found, sets a long backoff so
// we don't keep hammering the refresh endpoint, and kills the
// current Claude so the proactive-refresh cron can take over
// rotating the tokens (via restart.signal + fresh .credentials.json).

let authWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function startAuthWatchdog(): void {
	if (authWatchdogTimer) return;
	authWatchdogTimer = setInterval(() => {
		if (shuttingDown) return;
		if (Date.now() < authBackoffUntil) return;
		if (Date.now() - lastAuthTrigger < 60_000) return;
		try {
			const stat = statSync(STDOUT_LOG);
			// Log was truncated (rotated / fresh start) — rewind cursor
			if (stat.size < authScanCursor) authScanCursor = 0;
			// Only look at content appended since our last scan, capped at 16KB
			const unread = stat.size - authScanCursor;
			if (unread <= 0) return;
			const readSize = Math.min(unread, 16384);
			const fd = openSync(STDOUT_LOG, "r");
			const buf = Buffer.alloc(readSize);
			readSync(fd, buf, 0, readSize, stat.size - readSize);
			closeSync(fd);
			// Advance cursor — prevents re-triggering on stale log content
			authScanCursor = stat.size;
			const chunk = buf.toString("utf-8");
			if (!AUTH_ERROR_PATTERNS.some((p) => p.test(chunk))) return;

			lastAuthTrigger = Date.now();
			authBackoffUntil = Date.now() + AUTH_BACKOFF_MS;
			log(
				`auth error detected in stdout — backoff ${Math.round(AUTH_BACKOFF_MS / 60000)}min (until ${new Date(authBackoffUntil).toISOString()})`,
			);
			// Kill the current Claude so it stops retrying. startClaude's
			// backoff check will defer respawn until the window elapses.
			if (currentChild) {
				void killChild(currentChild);
			}
		} catch {
			// log missing or unreadable — ignore
		}
	}, AUTH_CHECK_INTERVAL_MS);
}

// ── Proactive OAuth refresh ───────────────────────────────────────
// Reads .credentials.json, calls the refresh endpoint, writes new
// tokens atomically, then triggers a graceful Claude restart via
// restart.signal so the spawned process picks up the fresh tokens
// from disk. Reschedules adaptively off the new expiry.

interface ClaudeCreds {
	claudeAiOauth?: {
		accessToken?: string;
		refreshToken?: string;
		expiresAt?: number;
		[k: string]: unknown;
	};
	[k: string]: unknown;
}

function readCreds(): ClaudeCreds | null {
	try {
		return JSON.parse(readFileSync(CREDS_FILE, "utf-8")) as ClaudeCreds;
	} catch (err) {
		log(`refresh: cannot read ${CREDS_FILE}: ${err}`);
		return null;
	}
}

async function refreshTokens(): Promise<boolean> {
	const creds = readCreds();
	const refreshToken = creds?.claudeAiOauth?.refreshToken;
	if (!creds || !refreshToken) {
		log("refresh: no refresh_token in credentials file");
		return false;
	}

	let resp: Response;
	try {
		resp = await fetch(OAUTH_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: OAUTH_CLIENT_ID,
			}),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		log(`refresh: network error — ${err}`);
		return false;
	}

	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		log(`refresh: HTTP ${resp.status} — ${body.slice(0, 200)}`);
		return false;
	}

	let data: {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};
	try {
		data = (await resp.json()) as typeof data;
	} catch (err) {
		log(`refresh: invalid JSON response — ${err}`);
		return false;
	}

	if (!data.access_token || !data.refresh_token || !data.expires_in) {
		log(`refresh: response missing fields — ${JSON.stringify(data).slice(0, 200)}`);
		return false;
	}

	// Preserve any other fields Claude may add (subscriptionType, scopes, etc.)
	const oauth = creds.claudeAiOauth ?? {};
	oauth.accessToken = data.access_token;
	oauth.refreshToken = data.refresh_token;
	oauth.expiresAt = Date.now() + data.expires_in * 1000;
	creds.claudeAiOauth = oauth;

	// Atomic write: temp in same dir → rename
	const tmp = `${CREDS_FILE}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
		renameSync(tmp, CREDS_FILE);
	} catch (err) {
		log(`refresh: write failed — ${err}`);
		try {
			rmSync(tmp, { force: true });
		} catch {}
		return false;
	}

	const expiresIso = new Date(oauth.expiresAt as number).toISOString();
	log(`refresh: OK — new access token expires ${expiresIso}`);
	return true;
}

function scheduleNextRefresh(): void {
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	const creds = readCreds();
	const expiresAt = creds?.claudeAiOauth?.expiresAt ?? 0;
	const timeLeft = expiresAt - Date.now();

	// Normal schedule: refresh at (lifetime - safety margin).
	// On consecutive failures, switch to growing backoff so we don't hammer
	// a rate-limited endpoint — 10min, 15min, 20min, ... capped later.
	let delay =
		consecutiveRefreshFails > 0
			? REFRESH_MIN_INTERVAL_MS * (1 + consecutiveRefreshFails)
			: timeLeft - REFRESH_SAFETY_MARGIN_MS;
	delay = Math.max(REFRESH_MIN_INTERVAL_MS, Math.min(REFRESH_MAX_INTERVAL_MS, delay));

	log(
		`refresh: next attempt in ${Math.round(delay / 60000)}min (token ${timeLeft > 0 ? `valid ${Math.round(timeLeft / 60000)}min` : "EXPIRED"}, fails=${consecutiveRefreshFails})`,
	);
	refreshTimer = setTimeout(() => void refreshCycle(), delay);
}

async function refreshCycle(): Promise<void> {
	const ok = await refreshTokens();
	if (ok) {
		consecutiveRefreshFails = 0;
		// Rotate Claude so the fresh tokens are loaded into its process memory.
		// Without rotation, Claude keeps using its in-memory old refresh_token —
		// which was invalidated by the rotation in the refresh response.
		try {
			mkdirSync(DATA_DIR, { recursive: true });
			writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
		} catch (err) {
			log(`refresh: could not signal restart — ${err}`);
		}
	} else {
		consecutiveRefreshFails++;
		if (consecutiveRefreshFails === 3) {
			log(
				"refresh: 3 consecutive failures — credentials may be revoked; " +
					"run `docker exec -it personal-claude-1 claude /login` to re-auth",
			);
		}
	}
	scheduleNextRefresh();
}

// Main
log("telegram daemon supervisor starting");
log(`router model: ${ROUTER_MODEL} (set TELEGRAM_ROUTER_MODEL to change)`);
log(`signal file: ${SIGNAL_FILE}`);
log(`claude args: ${[...BASE_ARGS, ...EXTRA_ARGS].join(" ")}`);
startWatching();
startContextWatchdog();
startAuthWatchdog();
scheduleNextRefresh();
void startClaude();
