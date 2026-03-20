# claude-telegram-supercharged

A community-driven, supercharged fork of Anthropic's official Claude Code Telegram plugin.

## Why this fork?

Anthropic's Claude Code Channels is an amazing product with huge potential. We recognized that immediately when it launched, and within hours we were already building on top of it.

But here's the reality: Anthropic has a lot on their plate. The official plugin ships the essentials, and that's great. But there are dozens of features, fixes, and improvements the community needs right now, and Anthropic simply can't prioritize them all.

**That's where we come in.**

This fork exists because we believe the best way to support a great product is to build around it. Instead of filing issues and waiting, we're shipping fixes and features ourselves, for ourselves and for the entire community.

## What's already improved

### MarkdownV2 formatting support
The official plugin sends all messages as plain text. `*bold*` and `_italic_` show up as raw characters in Telegram. We fixed that.

- Added `parse_mode` parameter to `reply` and `edit_message` tools
- Defaults to `MarkdownV2` so messages render with proper Telegram formatting
- Supports `HTML` and `plain` modes as fallback
- Updated MCP instructions so Claude knows how to use Telegram's formatting syntax

> Related issue: [anthropics/claude-code#36622](https://github.com/anthropics/claude-code/issues/36622)

## Roadmap

Here's what we're planning to build. PRs welcome!

- [ ] **Message history buffer** - Keep a rolling buffer of recent messages so Claude has context without asking users to repeat themselves
- [ ] **Scheduled messages** - Send messages at a specific time
- [ ] **Rich media replies** - Support for inline keyboards, polls, and formatted cards
- [ ] **Voice message transcription** - Auto-transcribe voice messages before forwarding to Claude
- [ ] **Multi-bot support** - Run multiple bots from one server instance
- [ ] **Conversation threading** - Smart thread management for group chats
- [ ] **Rate limiting & usage stats** - Track token usage and set limits per user
- [ ] **Webhook mode** - Alternative to polling for production deployments
- [ ] **Custom commands** - Define bot commands that map to Claude Code skills
- [ ] **Message templates** - Predefined response templates for common queries

## Installation

### Prerequisites
- [Bun](https://bun.sh) - Install with `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Setup

**1. Create a bot with [@BotFather](https://t.me/BotFather)** on Telegram. Send `/newbot`, pick a name and username. Copy the token.

**2. Clone this repo:**
```sh
git clone https://github.com/k1p1l0/claude-telegram-supercharged.git
```

**3. Configure the token:**
```sh
mkdir -p ~/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=your_token_here" > ~/.claude/channels/telegram/.env
```

**4. Launch Claude Code with the channel:**
```sh
claude --channels plugin:telegram@claude-plugins-official
```

> Note: Until custom channel sources are supported, you may need to replace the official plugin files with this fork's `server.ts`. See [Installation from fork](#installation-from-fork) below.

### Installation from fork

Replace the official plugin's server with the supercharged version:

```sh
cp server.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts
```

Then restart your Claude Code session.

**5. Pair your Telegram account.** DM the bot, then run in Claude Code:
```
/telegram:access pair <code>
```

## Tools

| Tool | Description |
| --- | --- |
| `reply` | Send a message. Supports `parse_mode` (MarkdownV2/HTML/plain), `reply_to` for threading, `files` for attachments. Auto-chunks long messages. |
| `react` | Add an emoji reaction (Telegram's fixed whitelist only). |
| `edit_message` | Edit a previously sent message. Supports `parse_mode`. |

## Access control

Full access control docs in [ACCESS.md](./ACCESS.md) - DM policies, group support, mention detection, and delivery configuration.

## Contributing

This is a community project. We want your help!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/voice-transcription`)
3. Make your changes
4. Test with a real Telegram bot
5. Open a PR with a clear description of what you changed and why

### Guidelines
- Keep changes focused - one feature per PR
- Test with real Telegram interactions, not just unit tests
- Update the README if you add new features or tools
- Follow the existing code style (TypeScript, grammy library)

## Credits

- **Original plugin** by [Anthropic](https://github.com/anthropics) - Apache 2.0 licensed
- **Community fork** maintained by [@k1p1l0](https://github.com/k1p1l0) and contributors
- Inspired by the Claude Code Channels launch by [@boris_cherny](https://www.threads.com/@boris_cherny)

## License

Apache 2.0 - Same as the original. See [LICENSE](./LICENSE).
