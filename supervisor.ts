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
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unwatchFile,
	watchFile,
} from "node:fs";
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
// Delay before restart to let Claude finish sending Telegram replies
const RESTART_DELAY_MS = 3_000;

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

async function killChild(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode !== null) return;

	child.kill("SIGTERM");

	await new Promise<void>((resolve) => {
		const deadline = setTimeout(() => {
			if (child.exitCode === null) {
				log("graceful timeout — sending SIGKILL");
				try {
					child.kill("SIGKILL");
				} catch {}
			}
			resolve();
		}, GRACEFUL_TIMEOUT_MS);

		child.once("exit", () => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

function startClaude(): void {
	if (shuttingDown) return;

	const uptime = Date.now() - lastStartTime;
	if (lastStartTime > 0 && uptime > STABLE_UPTIME_MS) {
		restartCount = 0;
	}

	lastStartTime = Date.now();
	const args = [...BASE_ARGS, ...EXTRA_ARGS];
	log(`spawning: ${CLAUDE_CMD} ${args.join(" ")}`);

	const child = spawn(CLAUDE_CMD, args, {
		stdio: "inherit",
		env: { ...process.env },
	});
	currentChild = child;

	child.on("exit", (code, signal) => {
		currentChild = null;
		if (shuttingDown) return;

		if (pendingRestart) {
			// Restart triggered by signal file — restart immediately
			pendingRestart = false;
			restartCount = 0;
			log("context reset complete — starting fresh session");
			setTimeout(startClaude, 200);
		} else if (code === 0) {
			// Clean exit — user typed /exit or similar
			log("claude exited cleanly (code=0) — restarting");
			restartCount = 0;
			setTimeout(startClaude, 200);
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

// Main
log("telegram daemon supervisor starting");
log(`signal file: ${SIGNAL_FILE}`);
log(`claude args: ${[...BASE_ARGS, ...EXTRA_ARGS].join(" ")}`);
startWatching();
startClaude();
