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
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	truncateSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import type { WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".claude", "channels", "telegram");
const DATA_DIR = join(STATE_DIR, "data");
const SIGNAL_FILE = join(DATA_DIR, "restart.signal");
const CLAUDE_CMD = "claude";
const BASE_ARGS = [
	"--channels",
	"plugin:telegram@claude-plugins-official",
	"--dangerously-skip-permissions",
];

// Extra args passed to this supervisor are forwarded to claude
const EXTRA_ARGS = process.argv.slice(2);

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;
const GRACEFUL_TIMEOUT_MS = 5_000;
const CONTEXT_CHECK_INTERVAL_MS = 30_000; // Check context every 30s
const MAX_SESSION_UPTIME_MS = 2 * 60 * 60 * 1000; // Force restart after 2 hours regardless of context
const STDOUT_LOG = join(DATA_DIR, "supervisor-stdout.log");
const STDOUT_LOG_MAX_BYTES = 1_000_000; // Truncate log on each spawn if larger
const EFFORT_FILE = join(DATA_DIR, "effort.json");
// Delay before restart to let Claude finish sending Telegram replies
const RESTART_DELAY_MS = 3_000;

// Token thresholds — primary signal for the context watchdog.
const CONTEXT_THRESHOLD_TOKENS = 100_000;
// Fallback when only a percentage status bar is visible.
const CONTEXT_DEFAULT_MAX_TOKENS = 200_000;
const CONTEXT_THRESHOLD_PCT_FALLBACK = Math.round(
	(CONTEXT_THRESHOLD_TOKENS / CONTEXT_DEFAULT_MAX_TOKENS) * 100,
);

let currentChild: ChildProcess | null = null;
let restartCount = 0;
let lastStartTime = 0;
let shuttingDown = false;
let pendingRestart = false;

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

// ── Persisted effort level ─────────────────────────────────────────
// Read from EFFORT_FILE to decide which --effort flag to append on spawn.
// Claude CLI supports: low | medium | high | max.
// "auto" is a Telegram-only sentinel meaning "don't pass --effort at all"
// (= use Claude's default classifier behavior).
function effortToCliArgs(): string[] {
	try {
		const raw = readFileSync(EFFORT_FILE, "utf-8");
		const data = JSON.parse(raw) as { effort?: string };
		if (
			data.effort === "low" ||
			data.effort === "medium" ||
			data.effort === "high" ||
			data.effort === "max"
		) {
			return ["--effort", data.effort];
		}
		// "auto" or anything else → no flag
	} catch {
		// File missing or invalid — fall through to no flag
	}
	return [];
}

let currentLogStream: WriteStream | null = null;
function openLogStream(): WriteStream {
	mkdirSync(DATA_DIR, { recursive: true });
	// Truncate the log if it grew too big — keeps disk usage bounded.
	try {
		const stat = statSync(STDOUT_LOG);
		if (stat.size > STDOUT_LOG_MAX_BYTES) {
			truncateSync(STDOUT_LOG, 0);
			log(`truncated supervisor-stdout.log (was ${stat.size} bytes)`);
		}
	} catch {}
	return createWriteStream(STDOUT_LOG, { flags: "a" });
}

async function startClaude(): Promise<void> {
	if (shuttingDown) return;

	// Kill any orphaned MCP server processes before starting fresh — WAIT for completion
	await cleanupOrphans();

	const uptime = Date.now() - lastStartTime;
	if (lastStartTime > 0 && uptime > STABLE_UPTIME_MS) {
		restartCount = 0;
	}

	// Brute-force kill any remaining bun server.ts processes
	try {
		const { execSync } = require("node:child_process");
		execSync("pkill -9 -f 'bun server.ts' || true; pkill -9 -f 'bun run.*--silent start' || true", { encoding: "utf-8" });
		log("killed all bun server.ts processes");
	} catch {}

	lastStartTime = Date.now();
	const effortArgs = effortToCliArgs();
	const args = [...BASE_ARGS, ...effortArgs, ...EXTRA_ARGS];
	log(`spawning: ${CLAUDE_CMD} ${args.join(" ")}`);
	// Use `expect` wrapper to allocate a PTY and auto-accept the workspace trust dialog.
	// expect spawns Claude with a pseudo-TTY (so it enters interactive mode under launchd)
	// and auto-sends Enter when it sees the "trust this folder" prompt.
	const EXPECT_WRAPPER = join(homedir(), ".claude", "scripts", "claude-daemon-wrapper.exp");
	// stdio = ["inherit", "pipe", "pipe"]: stdin stays interactive (so the
	// expect wrapper can receive input), but stdout/stderr are captured so
	// the context watchdog actually has something to read in STDOUT_LOG.
	currentLogStream = openLogStream();
	const child = spawn(EXPECT_WRAPPER, args, {
		stdio: ["inherit", "pipe", "pipe"],
		env: { ...process.env },
		detached: true, // Create a new process group so we can kill the entire tree
	});
	// Despite detached:true, we still want the child to die with the supervisor.
	// unref() is NOT called — the supervisor event loop keeps running.
	currentChild = child;

	// Tee stdout/stderr to BOTH the parent terminal (tmux visibility) and
	// the rotating log file (watchdog source of truth + /usage tool).
	const tee = (chunk: Buffer | string, dest: NodeJS.WritableStream): void => {
		dest.write(chunk);
		currentLogStream?.write(chunk);
	};
	child.stdout?.on("data", (chunk) => tee(chunk, process.stdout));
	child.stderr?.on("data", (chunk) => tee(chunk, process.stderr));

	child.on("exit", (code, signal) => {
		currentChild = null;
		try { currentLogStream?.end(); } catch {}
		currentLogStream = null;
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

// Kill any orphaned claude and MCP server processes from previous runs
async function cleanupOrphans(): Promise<void> {
	const { execSync } = await import("node:child_process");
	try {
		const myPid = process.pid;

		// Find orphaned claude processes AND stale bun server.ts (MCP) processes
		const patterns = [
			"claude.*--channels.*telegram",
			"bun server\\.ts",
			"bun run.*--silent start",
		];
		const allPids: number[] = [];

		for (const pattern of patterns) {
			const result = execSync(
				`pgrep -f '${pattern}' || true`,
				{ encoding: "utf-8" },
			).trim();
			if (!result) continue;

			const pids = result
				.split("\n")
				.map((p) => Number.parseInt(p.trim(), 10))
				.filter((p) => !Number.isNaN(p) && p !== myPid);

			allPids.push(...pids);
		}

		if (allPids.length === 0) return;

		// Deduplicate
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

// ── Restart trigger ───────────────────────────────────────────────
// Schedules a graceful restart by writing the restart.signal file.
// server.ts watches the signal and triggers the supervisor to kill+respawn.

function triggerRestart(reason: string): void {
	log(`triggering restart (reason: ${reason})`);
	mkdirSync(join(SIGNAL_FILE, ".."), { recursive: true });
	writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
}

// ── Context watchdog ──────────────────────────────────────────────
// Monitors the stdout log for context usage and triggers a graceful
// restart when it exceeds CONTEXT_THRESHOLD_TOKENS (or the pct fallback)
// to prevent the session from becoming unresponsive.

export interface UsageReading {
	tokens: number | null;
	pct: number | null;
}

/** Read the most recent usage signal from STDOUT_LOG. Returns nulls if nothing found. */
export function readLatestUsage(): UsageReading {
	try {
		const stat = statSync(STDOUT_LOG);
		// Read last 8KB — enough for several status bar lines
		const readSize = Math.min(stat.size, 8192);
		const fd = openSync(STDOUT_LOG, "r");
		const buf = Buffer.alloc(readSize);
		readSync(fd, buf, 0, readSize, stat.size - readSize);
		closeSync(fd);
		const tail = buf.toString("utf-8");

		// Prefer explicit token count if Claude logs one (e.g. "150k/200k tokens")
		const tokMatches = [
			...tail.matchAll(/(\d+(?:\.\d+)?)\s*[kK]\s*\/\s*\d+(?:\.\d+)?\s*[kK]\s*tokens/g),
		];
		if (tokMatches.length > 0) {
			const last = tokMatches[tokMatches.length - 1][1];
			const tokens = Math.round(Number.parseFloat(last) * 1000);
			return { tokens, pct: null };
		}

		// Fallback: status bar pattern ░█ followed by percentage.
		// Negative lookahead avoids matching "85% sure" inside message content.
		const pctMatches = [...tail.matchAll(/[█░]+\s+(\d{1,3})%/g)];
		if (pctMatches.length > 0) {
			const pct = Number.parseInt(pctMatches[pctMatches.length - 1][1], 10);
			return { tokens: null, pct };
		}
	} catch {
		// Log file may not exist yet
	}
	return { tokens: null, pct: null };
}

let contextWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastWatchdogTrigger = 0;

function startContextWatchdog(): void {
	if (contextWatchdogTimer) return;
	contextWatchdogTimer = setInterval(() => {
		if (!currentChild || shuttingDown) return;
		// Debounce: don't trigger more than once per 60 seconds
		if (Date.now() - lastWatchdogTrigger < 60_000) return;

		const usage = readLatestUsage();

		// Check 1a: explicit token count exceeds threshold
		if (usage.tokens !== null && usage.tokens >= CONTEXT_THRESHOLD_TOKENS) {
			log(`context watchdog: usage at ${usage.tokens} tokens (threshold: ${CONTEXT_THRESHOLD_TOKENS}) — triggering restart`);
			lastWatchdogTrigger = Date.now();
			triggerRestart("context-tokens");
			return;
		}

		// Check 1b: percentage status bar at/above fallback threshold
		if (usage.pct !== null && usage.pct >= CONTEXT_THRESHOLD_PCT_FALLBACK && usage.pct <= 100) {
			log(`context watchdog: usage at ${usage.pct}% (fallback threshold: ${CONTEXT_THRESHOLD_PCT_FALLBACK}%, ~${CONTEXT_THRESHOLD_TOKENS} tokens) — triggering restart`);
			lastWatchdogTrigger = Date.now();
			triggerRestart("context-pct");
			return;
		}

		// Check 2: session running too long (prevents dormancy bug)
		const uptime = Date.now() - lastStartTime;
		if (uptime > MAX_SESSION_UPTIME_MS) {
			log(`context watchdog: session uptime ${Math.round(uptime / 60000)}min exceeds max ${Math.round(MAX_SESSION_UPTIME_MS / 60000)}min — triggering restart`);
			lastWatchdogTrigger = Date.now();
			triggerRestart("uptime");
			return;
		}
	}, CONTEXT_CHECK_INTERVAL_MS);
}

// Main
log("telegram daemon supervisor starting");
log(`signal file: ${SIGNAL_FILE}`);
log(`claude args: ${[...BASE_ARGS, ...EXTRA_ARGS].join(" ")}`);
startWatching();
startContextWatchdog();
void cleanupOrphans().then(() => {
	startClaude();
});
