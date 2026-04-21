#!/usr/bin/env bun
/**
 * Minimal stdio MCP server for per-topic worker containers.
 *
 * The worker's Claude Code session gets inbound messages by tmux send-keys
 * (injected by the master's telegram channel). It replies by calling the
 * `telegram_reply` tool exposed here, which hits the Telegram Bot API
 * directly using the same shared bot token the master polls with.
 *
 * The worker is not a "channel" — it's a regular claude CLI session with
 * one custom MCP server. No OAuth token leaves Claude Code, no Agent SDK,
 * no channel-plugin allowlist needed.
 *
 * Env: TELEGRAM_BOT_TOKEN (required)
 *      TELEGRAM_DEFAULT_CHAT_ID (optional — default chat if Claude omits it)
 *      TELEGRAM_DEFAULT_THREAD_ID (optional — default Forum topic)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  process.stderr.write("telegram-send-mcp: TELEGRAM_BOT_TOKEN required\n");
  process.exit(1);
}

const DEFAULT_CHAT = process.env.TELEGRAM_DEFAULT_CHAT_ID;
const DEFAULT_THREAD = process.env.TELEGRAM_DEFAULT_THREAD_ID;
const API_BASE = `https://api.telegram.org/bot${TOKEN}`;

type TgResponse = { ok: boolean; result?: unknown; description?: string };

async function tgCall(method: string, params: Record<string, unknown>): Promise<TgResponse> {
  const resp = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return (await resp.json()) as TgResponse;
}

const server = new Server(
  { name: "telegram-send", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "telegram_reply",
      description:
        "Send a text reply to the Telegram chat/topic this worker is assigned to. chat_id and thread_id default to the container's configured topic — pass them only to override. Returns the sent message_id.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Message body. Max 4096 chars (Telegram limit); longer text is truncated." },
          chat_id: { type: "string", description: "Override default chat_id." },
          thread_id: { type: "number", description: "Override default Forum topic thread_id." },
          reply_to_message_id: { type: "number", description: "Quote-reply to this message_id in the topic." },
        },
        required: ["text"],
      },
    },
    {
      name: "telegram_react",
      description:
        "Set one emoji reaction on a Telegram message. Use sparingly — Telegram allows one bot reaction per message, so calling this twice replaces the first.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "number" },
          emoji: { type: "string", description: "Single emoji. Must be in Telegram's allowed reaction set (👍 👎 ❤ 🔥 👀 🤔 …)." },
          chat_id: { type: "string", description: "Override default chat_id." },
        },
        required: ["message_id", "emoji"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  if (name === "telegram_reply") {
    const chat_id = (a.chat_id as string | undefined) ?? DEFAULT_CHAT;
    if (!chat_id) throw new Error("chat_id required (no TELEGRAM_DEFAULT_CHAT_ID configured)");
    const text = String(a.text ?? "").slice(0, 4096);
    if (!text) throw new Error("text required");
    const thread_id = (a.thread_id as number | undefined) ?? (DEFAULT_THREAD ? Number(DEFAULT_THREAD) : undefined);
    const reply_to_message_id = a.reply_to_message_id as number | undefined;

    const params: Record<string, unknown> = { chat_id, text };
    if (thread_id != null) params.message_thread_id = thread_id;
    if (reply_to_message_id != null) params.reply_parameters = { message_id: reply_to_message_id };

    const resp = await tgCall("sendMessage", params);
    if (!resp.ok) throw new Error(`Telegram API error: ${resp.description}`);
    const sent = resp.result as { message_id: number };
    return { content: [{ type: "text", text: `sent (message_id: ${sent.message_id})` }] };
  }

  if (name === "telegram_react") {
    const chat_id = (a.chat_id as string | undefined) ?? DEFAULT_CHAT;
    if (!chat_id) throw new Error("chat_id required (no TELEGRAM_DEFAULT_CHAT_ID configured)");
    const message_id = Number(a.message_id);
    const emoji = String(a.emoji ?? "");
    if (!emoji) throw new Error("emoji required");

    const resp = await tgCall("setMessageReaction", {
      chat_id,
      message_id,
      reaction: [{ type: "emoji", emoji }],
    });
    if (!resp.ok) throw new Error(`Telegram API error: ${resp.description}`);
    return { content: [{ type: "text", text: `reacted ${emoji}` }] };
  }

  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`telegram-send-mcp: ready (default chat=${DEFAULT_CHAT ?? "<none>"}, thread=${DEFAULT_THREAD ?? "<none>"})\n`);
