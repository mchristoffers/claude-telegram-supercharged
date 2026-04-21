import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirror of server.ts in the Supercharged fork: load TELEGRAM_BOT_TOKEN
// from ~/.claude/channels/telegram/.env (plugin-spawned servers don't get
// a shell env). Real env wins.
const ENV_FILE = join(homedir(), ".claude", "channels", "telegram", ".env");
try {
  for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
} catch {
  // fine — env may already be injected by compose
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.NOTIFY_CHAT_ID;
const THREAD_ID = process.env.NOTIFY_THREAD_ID; // optional — omit for General

export function notifyEnabled(): boolean {
  return !!TOKEN && !!CHAT_ID;
}

export async function notify(text: string): Promise<void> {
  if (!notifyEnabled()) return;
  const body: Record<string, unknown> = {
    chat_id: CHAT_ID,
    text,
    parse_mode: "MarkdownV2",
    disable_notification: true,
  };
  if (THREAD_ID) body.message_thread_id = Number(THREAD_ID);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`telegram notify failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("telegram notify threw:", err);
  }
}

// Telegram's MarkdownV2 needs every reserved char escaped in plain text.
export function md2(s: string): string {
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
