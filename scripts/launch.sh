#!/usr/bin/env bash

# Launch script: starts the proxy in the background and runs Claude Code
# Usage: ./scripts/launch.sh [claude-code-args...]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${COPILOT_PROXY_PORT:-18080}"
AUTH_FILE="${COPILOT_AUTH_FILE:-$HOME/.claude-copilot-auth.json}"

# Check auth
if [ ! -f "$AUTH_FILE" ]; then
    echo "✗ Not authenticated. Run authentication first:"
    echo "  node $SCRIPT_DIR/auth.mjs"
    exit 1
fi

# Check if proxy is already running
if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "✓ Proxy already running on port $PORT"
else
    echo "Starting proxy server..."
    node "$SCRIPT_DIR/proxy.mjs" &
    PROXY_PID=$!

    # Wait for proxy to be ready
    for i in $(seq 1 30); do
        if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
            break
        fi
        sleep 0.2
    done

    if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
        echo "✗ Proxy failed to start"
        kill $PROXY_PID 2>/dev/null
        exit 1
    fi

    echo "✓ Proxy started (PID: $PROXY_PID)"

    # Clean up proxy on exit
    trap "echo 'Stopping proxy...'; kill $PROXY_PID 2>/dev/null" EXIT
fi

echo "Starting Claude Code via Copilot..."
echo ""

ANTHROPIC_BASE_URL="http://localhost:$PORT" \
ANTHROPIC_API_KEY="copilot-proxy" \
claude "$@"
