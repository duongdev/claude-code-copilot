# Claude Code via GitHub Copilot

Use **Claude Code for free** by routing it through your existing GitHub Copilot subscription.

This project runs a lightweight local proxy that translates between Anthropic's Messages API (which Claude Code speaks) and OpenAI's Chat Completions API (which GitHub Copilot speaks). No Anthropic API key needed — just your Copilot subscription.

## Features

- **Full API Translation** — Anthropic Messages API ↔ OpenAI Chat Completions, including streaming
- **Web Search** — Emulates Anthropic's `web_search_20250305` tool using DuckDuckGo Lite (free) or Brave Search API
- **Docker Support** — Run the proxy as an always-on container that survives reboots
- **Zero Dependencies** — Pure Node.js, no npm install needed

## Supported Models

All Claude models available through your Copilot subscription work out of the box:

| Model | Copilot ID |
|---|---|
| Claude Opus 4.6 | `claude-opus-4.6` |
| Claude Sonnet 4.5 | `claude-sonnet-4.5` |
| Claude Sonnet 4 | `claude-sonnet-4` |
| Claude Opus 4.5 | `claude-opus-4.5` |
| Claude Haiku 4.5 | `claude-haiku-4.5` |

## Prerequisites

- GitHub account with an **active Copilot subscription** (Individual, Business, or Enterprise)
- [Node.js](https://nodejs.org/) 18+ (or [Docker](https://www.docker.com/))
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)

## Quick Start

### 1. Clone this repo

```bash
git clone https://github.com/samarth777/claude-code-copilot.git
cd claude-code-copilot
```

### 2. Authenticate with GitHub

```bash
node scripts/auth.mjs
```

This opens a GitHub device code flow in your browser (same as VS Code uses for Copilot). Your token is saved to `~/.claude-copilot-auth.json`.

### 3. Start Claude Code

**Option A — One command (recommended):**

```bash
./scripts/launch.sh
```

This auto-starts the proxy (via Docker if available, otherwise as a background process) and launches Claude Code.

**Option B — Docker (always-on proxy):**

```bash
docker compose up -d
```

The proxy runs as a Docker container with `restart: always` — it stays running across reboots. Then run Claude Code separately:

```bash
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_API_KEY=copilot-proxy claude
```

**Option C — Manual (two terminals):**

```bash
# Terminal 1: Start the proxy
node scripts/proxy.mjs

# Terminal 2: Run Claude Code
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_API_KEY=copilot-proxy claude
```

### 4. Select your model

Inside Claude Code, use `/model` to switch between models (Opus 4.6, Sonnet 4.5, etc.).

## Docker

The proxy can run as an always-on Docker container that auto-restarts on crashes and reboots:

```bash
# Start (builds automatically)
docker compose up -d

# View logs
docker logs claude-copilot-proxy

# Restart
docker restart claude-copilot-proxy

# Stop
docker compose down
```

The container mounts your auth token (`~/.claude-copilot-auth.json`) read-only and exposes port 18080.

## Web Search

The proxy emulates Anthropic's `web_search_20250305` server-side tool, so Claude Code's WebSearch works through the proxy.

**Search providers (in priority order):**

1. **Brave Search API** — Best results. Set `BRAVE_API_KEY` env var (free tier: 2000 queries/month at [api.search.brave.com](https://api.search.brave.com/))
2. **DuckDuckGo Lite** — Free, no API key needed. Used by default.
3. **DuckDuckGo Instant Answer** — Last resort fallback.

To use Brave Search with Docker:

```bash
BRAVE_API_KEY=your-key-here docker compose up -d
```

## Shell Alias (Optional)

Add to your `~/.zshrc` or `~/.bashrc` for quick access:

```bash
alias claude-copilot='/path/to/claude-code-copilot/scripts/launch.sh'
```

Then just run `claude-copilot` from anywhere. The launch script handles starting the proxy automatically.

## How It Works

```
┌─────────────┐    Anthropic API     ┌──────────────┐    OpenAI API      ┌──────────────────────┐
│             │    (Messages)        │              │    (Chat Compl.)   │                      │
│ Claude Code │ ──────────────────▶  │  Local Proxy │ ──────────────────▶│ api.githubcopilot.com│
│             │ ◀──────────────────  │  :18080      │ ◀──────────────────│                      │
└─────────────┘                      └──────────────┘                    └──────────────────────┘
```

1. Claude Code sends requests in Anthropic Messages API format to the local proxy
2. The proxy translates messages, tools, and system prompts to OpenAI Chat Completions format
3. Requests are forwarded to `api.githubcopilot.com` with your GitHub OAuth token
4. Responses are translated back to Anthropic format and streamed to Claude Code

No data is stored or logged — the proxy is a stateless pass-through.

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COPILOT_PROXY_PORT` | `18080` | Port for the local proxy |
| `COPILOT_AUTH_FILE` | `~/.claude-copilot-auth.json` | Path to saved OAuth token |
| `BRAVE_API_KEY` | *(none)* | Brave Search API key for web search |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Max search results per query |
| `DEBUG_STREAM` | `0` | Set to `1` to log raw streaming chunks |

## Troubleshooting

### "There's an issue with the selected model"

The model name Claude Code sends may not be mapped. Check proxy logs for the exact model string and [open an issue](../../issues).

### "401 Unauthorized" from Copilot

Your GitHub token has expired. Re-authenticate:

```bash
rm ~/.claude-copilot-auth.json
node scripts/auth.mjs
```

### "EADDRINUSE: address already in use"

Kill the existing proxy process:

```bash
lsof -ti:18080 | xargs kill -9
```

### Proxy is running but Claude Code shows errors

Make sure you're passing both environment variables:

```bash
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_API_KEY=copilot-proxy claude
```

`ANTHROPIC_API_KEY` must be set (any value works), otherwise Claude Code won't start.

## Project Structure

```
├── scripts/
│   ├── auth.mjs      # GitHub OAuth device code flow
│   ├── proxy.mjs     # Anthropic ↔ OpenAI translation proxy
│   └── launch.sh     # One-command launcher (Docker-aware)
├── commands/
│   └── setup-copilot.md  # Claude Code /slash command
├── Dockerfile
├── docker-compose.yml
├── package.json
├── LICENSE
└── README.md
```

## Contributing

Contributions welcome! Some ideas:

- **More model mappings** — as Anthropic/GitHub add new models
- **Caching** — cache system prompt tokens to reduce latency
- **Token refresh** — auto-refresh expired GitHub tokens
- **More search providers** — Google Custom Search, SearXNG, etc.

## License

MIT
