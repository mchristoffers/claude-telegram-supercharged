# syntax=docker/dockerfile:1
# Per-topic worker container. Runs a regular `claude` CLI session in tmux
# against a minimal graphical desktop (Xvfb + fluxbox) reachable via VNC.
# Messages are injected by the master via `docker exec ... tmux send-keys`.
# Replies go out through the telegram-send MCP server.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # Core
    ca-certificates curl wget unzip git jq tmux openssh-server \
    python3-minimal \
    # Graphical stack — Xvfb + a tiny WM + VNC. No full DE to keep the image lean.
    xvfb x11-utils xauth fluxbox x11vnc \
    # GUI automation toolchain — xdotool + scrot + wmctrl are in Claude's
    # training data for decades, so the worker can see-click-type without
    # a custom MCP. imagemagick's `import` is a scrot fallback.
    xdotool scrot wmctrl imagemagick \
    # USB userspace — lets Claude poke at devices mounted by the host
    usbutils \
    # ffmpeg for media (matches master)
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Bun (for MCP server) + Claude Code + cc-account-switcher
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -fsSL https://raw.githubusercontent.com/ming86/cc-account-switcher/main/ccswitch.sh \
    -o /usr/local/bin/ccswitch && chmod +x /usr/local/bin/ccswitch

ENV PATH="/root/.local/bin:/root/.bun/bin:${PATH}"
ENV DISPLAY=:1
ENV IS_SANDBOX=1
ENV SCREEN_GEOMETRY=1920x1080x24

RUN mkdir /run/sshd && \
    echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && \
    echo 'set -g window-size latest' > /root/.tmux.conf && \
    echo 'set -g aggressive-resize on' >> /root/.tmux.conf

# Custom MCP server for Telegram replies. Worker's Claude gets this as its
# only Telegram tool surface — no channel plugin, no polling.
COPY mcp-telegram-send /opt/mcp-telegram-send
RUN cd /opt/mcp-telegram-send && bun install

# Default CLAUDE.md for the worker's cwd. Copied into /workspace by the
# entrypoint on first boot (never overwrites — the user can edit their
# own per-topic CLAUDE.md on the host).
COPY default-CLAUDE.md /opt/default-CLAUDE.md

WORKDIR /workspace
EXPOSE 22 5900

COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
