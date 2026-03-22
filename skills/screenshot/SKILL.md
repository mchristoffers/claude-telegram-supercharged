---
name: screenshot
description: Take a screenshot of a web page using Playwright (headless browser). Use as a fallback when Chrome MCP isn't connected — works in headless daemon mode. Triggers when asked to screenshot, capture, or snap a URL, or when Chrome tools fail with "not connected".
user-invocable: true
allowed-tools:
  - Bash(npx *)
  - Bash(node *)
  - Bash(ls *)
  - Bash(cat *)
  - Read
---

# /telegram:screenshot — Headless Page Screenshot

Takes a screenshot of a web page using Playwright's headless Chromium. Works
in daemon mode where Chrome MCP isn't available.

## When to use

- Chrome MCP returns "not connected" or is unavailable
- Running in headless/daemon mode (no GUI)
- User asks to screenshot/capture a URL
- The `threads-scrape` or similar skill needs a visual snapshot

## Implementation

Use Playwright via the `mcp__playwright__*` tools if available. If those tools
aren't available either, fall back to a direct Node.js script:

### Option 1: Playwright MCP tools (preferred)

Try these tools in order:
1. `mcp__playwright__browser_navigate` — navigate to the URL
2. `mcp__playwright__browser_take_screenshot` — capture the page

### Option 2: Direct script fallback

If Playwright MCP isn't available, run a one-shot Node.js script:

```bash
npx playwright screenshot --browser chromium --wait-for-timeout 3000 --full-page "URL" /tmp/screenshot.png
```

If `npx playwright` isn't installed:

```bash
npx -y playwright screenshot --browser chromium "URL" /tmp/screenshot.png
```

### Screenshot storage

Save screenshots to the Telegram inbox directory so they can be sent as replies:

```
~/.claude/channels/telegram/inbox/screenshot-TIMESTAMP.png
```

Then use the `reply` tool with `files: ["/path/to/screenshot.png"]` to send it
to the user in Telegram.

## Arguments

- `<url>` — URL to screenshot (required)
- `full` — take a full-page screenshot (default: viewport only)
- `mobile` — use mobile viewport (390x844)

## Example flows

**Basic screenshot:**
1. Navigate to URL with Playwright
2. Wait for page load (networkidle or 3s timeout)
3. Take screenshot
4. Save to inbox
5. Reply with the image file attached

**Threads profile screenshot:**
1. Navigate to `threads.com/@username`
2. Wait for content to load
3. Take full-page screenshot
4. Save and send via reply

## Error handling

- If Playwright isn't installed: suggest `npx playwright install chromium`
- If the page times out: retry once with longer timeout (10s)
- If the URL is invalid: report the error to the user
- Always clean up browser instances (close the page/browser)
