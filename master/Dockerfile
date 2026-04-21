# syntax=docker/dockerfile:1
FROM node:22-slim

# System packages — lean: no Python, no browser libs
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    tmux openssh-server curl unzip git jq wget ca-certificates \
    python3-minimal python3-venv ffmpeg \
    docker.io

# Static config
RUN mkdir /run/sshd && \
    echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && \
    echo 'set -g window-size latest' > /root/.tmux.conf && \
    echo 'set -g aggressive-resize on' >> /root/.tmux.conf

# Tools — one layer each
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

ENV PATH="/root/.local/bin:/root/.bun/bin:/root/.cargo/bin:${PATH}"

# cc-account-switcher
RUN curl -fsSL https://raw.githubusercontent.com/ming86/cc-account-switcher/main/ccswitch.sh \
    -o /usr/local/bin/ccswitch && \
    chmod +x /usr/local/bin/ccswitch

ENV IS_SANDBOX=1
ENV TELEGRAPH_ENABLED=true
WORKDIR /app
EXPOSE 22

COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
