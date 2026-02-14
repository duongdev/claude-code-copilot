#!/usr/bin/env node

/**
 * Anthropic → GitHub Copilot Proxy Server
 *
 * Accepts requests in Anthropic Messages API format, translates them to
 * OpenAI Chat Completions format, forwards to api.githubcopilot.com,
 * and translates responses back to Anthropic format.
 *
 * This allows Claude Code to use GitHub Copilot as its model provider.
 */

import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PORT = parseInt(process.env.COPILOT_PROXY_PORT || "18080", 10)
const AUTH_FILE =
  process.env.COPILOT_AUTH_FILE || join(homedir(), ".claude-copilot-auth.json")
const COPILOT_API_BASE = "https://api.githubcopilot.com"
const USER_AGENT = "claude-code-copilot-provider/1.0.0"

// ─── Model Mapping ──────────────────────────────────────────────────────────

const MODEL_MAP = {
  // Opus 4.6
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-6-20260214": "claude-opus-4.6",
  "claude-opus-4-6-latest": "claude-opus-4.6",
  // Sonnet 4.5
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-5-latest": "claude-sonnet-4.5",
  // Sonnet 4
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4",
  "claude-3-5-sonnet-latest": "claude-sonnet-4",
  // Opus 4.5
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-opus-4-5-latest": "claude-opus-4.5",
  // Opus 4.1
  "claude-opus-4-1": "claude-opus-41",
  "claude-opus-4-1-latest": "claude-opus-41",
  // Haiku 4.5
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-haiku-4-5-latest": "claude-haiku-4.5",
  "claude-haiku-4-20250414": "claude-haiku-4.5",
  "claude-3-5-haiku-20241022": "claude-haiku-4.5",
  "claude-3-haiku-20240307": "claude-haiku-4.5",
  // Legacy opus
  "claude-opus-4-20250918": "claude-opus-4.5",
  "claude-3-opus-20240229": "claude-opus-4.5",
  "claude-3-5-opus-latest": "claude-opus-4.5",
}

// Fallback: try to intelligently map unknown model names
function mapModel(anthropicModel) {
  if (MODEL_MAP[anthropicModel]) return MODEL_MAP[anthropicModel]

  // Try pattern matching for unknown dated versions
  const m = anthropicModel.toLowerCase()
  if (m.includes("opus") && (m.includes("4.6") || m.includes("4-6"))) return "claude-opus-4.6"
  if (m.includes("sonnet") && (m.includes("4.5") || m.includes("4-5"))) return "claude-sonnet-4.5"
  if (m.includes("sonnet")) return "claude-sonnet-4"
  if (m.includes("opus") && (m.includes("4.5") || m.includes("4-5"))) return "claude-opus-4.5"
  if (m.includes("opus") && (m.includes("4.1") || m.includes("4-1") || m.includes("41"))) return "claude-opus-41"
  if (m.includes("haiku")) return "claude-haiku-4.5"
  if (m.includes("opus")) return "claude-opus-4.6"

  // Pass through as-is
  return anthropicModel
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function loadAuth() {
  if (!existsSync(AUTH_FILE)) {
    console.error(`✗ Auth file not found: ${AUTH_FILE}`)
    console.error("  Run 'node scripts/auth.mjs' first to authenticate.")
    process.exit(1)
  }

  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
    if (!data.access_token) {
      throw new Error("No access_token in auth file")
    }
    return data.access_token
  } catch (err) {
    console.error(`✗ Failed to read auth file: ${err.message}`)
    process.exit(1)
  }
}

// ─── Message Translation (Anthropic → OpenAI) ───────────────────────────────

function translateContentPart(part) {
  if (typeof part === "string") {
    return { type: "text", text: part }
  }

  switch (part.type) {
    case "text":
      return { type: "text", text: part.text }
    case "image":
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.source.media_type};base64,${part.source.data}`,
        },
      }
    case "tool_use":
      return null // Handled separately
    case "tool_result":
      return null // Handled separately
    default:
      return { type: "text", text: JSON.stringify(part) }
  }
}

function translateMessages(anthropicMessages, system) {
  const openaiMessages = []

  // System message
  if (system) {
    if (typeof system === "string") {
      openaiMessages.push({ role: "system", content: system })
    } else if (Array.isArray(system)) {
      const systemText = system
        .map((s) => {
          if (typeof s === "string") return s
          if (s.type === "text") return s.text
          return JSON.stringify(s)
        })
        .join("\n\n")
      openaiMessages.push({ role: "system", content: systemText })
    }
  }

  for (const msg of anthropicMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        openaiMessages.push({ role: "user", content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // Check for tool_result blocks
        const toolResults = msg.content.filter((p) => p.type === "tool_result")
        const otherParts = msg.content.filter((p) => p.type !== "tool_result")

        // Tool results become separate tool messages
        for (const result of toolResults) {
          let content
          if (typeof result.content === "string") {
            content = result.content
          } else if (Array.isArray(result.content)) {
            content = result.content
              .map((p) => (p.type === "text" ? p.text : JSON.stringify(p)))
              .join("\n")
          } else {
            content = JSON.stringify(result.content)
          }

          openaiMessages.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: content || "",
          })
        }

        // Format remaining content parts
        if (otherParts.length > 0) {
          const parts = otherParts.map(translateContentPart).filter(Boolean)
          if (parts.length === 1 && parts[0].type === "text") {
            openaiMessages.push({ role: "user", content: parts[0].text })
          } else if (parts.length > 0) {
            openaiMessages.push({ role: "user", content: parts })
          }
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        openaiMessages.push({ role: "assistant", content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p) => p.type === "text")
        const toolUses = msg.content.filter((p) => p.type === "tool_use")

        const assistantMsg = {
          role: "assistant",
          content:
            textParts.length > 0
              ? textParts.map((p) => p.text).join("\n")
              : toolUses.length > 0
                ? null
                : "",
        }

        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input || {}),
            },
          }))
        }

        openaiMessages.push(assistantMsg)
      }
    }
  }

  return openaiMessages
}

// ─── Tool Translation ─────────────────────────────────────────────────────────

function translateTools(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return undefined

  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }))
}

// ─── Response Translation (OpenAI → Anthropic) ──────────────────────────────

function translateResponseToAnthropic(openaiResponse, model) {
  const choice = openaiResponse.choices?.[0]
  if (!choice) {
    return {
      id: openaiResponse.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: model,
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: openaiResponse.usage?.prompt_tokens || 0,
        output_tokens: openaiResponse.usage?.completion_tokens || 0,
      },
    }
  }

  const content = []

  // Text content
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  // Tool calls
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: (() => {
          try {
            return JSON.parse(tc.function.arguments)
          } catch {
            return {}
          }
        })(),
      })
    }
  }

  // Map finish reason
  let stopReason = "end_turn"
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
  else if (choice.finish_reason === "length") stopReason = "max_tokens"
  else if (choice.finish_reason === "content_filter") stopReason = "end_turn"

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

// ─── Streaming Translation ──────────────────────────────────────────────────

function createStreamTranslator(model, res) {
  let messageId = `msg_${Date.now()}`
  let inputTokens = 0
  let outputTokens = 0
  let sentStart = false
  let toolCallBuffers = {} // id -> {name, arguments}

  function sendSSE(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    res.write(line)
  }

  // Debug: log raw Copilot chunks
  const DEBUG_STREAM = process.env.DEBUG_STREAM === "1"

  function sendStartIfNeeded() {
    if (!sentStart) {
      sentStart = true
      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
  }

  let contentBlockIndex = 0

  return {
    processChunk(chunk) {
      // Parse OpenAI SSE chunk
      if (!chunk || chunk === "[DONE]") {
        // Send message_stop
        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })
        sendSSE("message_stop", { type: "message_stop" })
        return true // done
      }

      let data
      try {
        data = typeof chunk === "string" ? JSON.parse(chunk) : chunk
      } catch {
        return false
      }

      sendStartIfNeeded()

      if (data.usage) {
        inputTokens = data.usage.prompt_tokens || inputTokens
        outputTokens = data.usage.completion_tokens || outputTokens
      }

      const choice = data.choices?.[0]
      if (!choice) return false

      const delta = choice.delta
      if (DEBUG_STREAM) console.log(`  [stream] delta=${JSON.stringify(delta)?.substring(0, 120)} finish=${choice.finish_reason || ""}`)

      // Text content
      if (delta?.content) {
        if (!this._inTextBlock) {
          sendSSE("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          })
          this._inTextBlock = true
        }

        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        })
      }

      // Tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0
          const tcId = tc.id

          if (tcId) {
            // Close text block if open
            if (this._inTextBlock) {
              sendSSE("content_block_stop", {
                type: "content_block_stop",
                index: contentBlockIndex,
              })
              contentBlockIndex++
              this._inTextBlock = false
            }

            // New tool call
            toolCallBuffers[tcIndex] = {
              id: tcId,
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            }

            sendSSE("content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex + tcIndex,
              content_block: {
                type: "tool_use",
                id: tcId,
                name: tc.function?.name || "",
                input: {},
              },
            })
          } else if (tc.function?.arguments) {
            // Continuation of tool call arguments
            if (toolCallBuffers[tcIndex]) {
              toolCallBuffers[tcIndex].arguments += tc.function.arguments
            }

            sendSSE("content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex + tcIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            })
          }
        }
      }

      // Handle finish
      if (choice.finish_reason) {
        // Close any open blocks
        if (this._inTextBlock) {
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          })
          this._inTextBlock = false
        }

        // Close tool call blocks
        for (const idx of Object.keys(toolCallBuffers)) {
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex + parseInt(idx),
          })
        }

        let stopReason = "end_turn"
        if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
        else if (choice.finish_reason === "length") stopReason = "max_tokens"

        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })
        sendSSE("message_stop", { type: "message_stop" })
        return true
      }

      return false
    },

    _inTextBlock: false,
  }
}

// ─── Request Handler ─────────────────────────────────────────────────────────

async function handleRequest(req, res, token) {
  const url = req.url || ""
  const method = req.method || "GET"

  // Log every request for debugging
  console.log(`[${new Date().toISOString()}] ${method} ${url}`)

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")

  if (method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  // Health check
  if (url === "/health" || url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", provider: "github-copilot" }))
    return
  }

  // Handle messages endpoint - match any path ending in /messages or containing messages
  const isMessagesEndpoint = url.includes("/messages")

  // Handle token counting / tokenizer endpoints - Claude Code calls this
  if (url.includes("/count_tokens") || url.includes("/token")) {
    // Read body to get token count request for accurate-ish estimation
    let body = ""
    for await (const chunk of req) {
      body += chunk
    }
    let inputTokens = 0
    try {
      const data = JSON.parse(body)
      // Rough estimation: ~4 chars per token
      const text = JSON.stringify(data.messages || []) + JSON.stringify(data.system || "")
      inputTokens = Math.ceil(text.length / 4)
    } catch {}
    console.log(`  ⚡ Token count → ~${inputTokens} tokens (estimated)`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ input_tokens: inputTokens }))
    return
  }

  // Handle models list endpoint — Claude Code may probe this
  if (url.includes("/models")) {
    console.log(`  ⚡ Models endpoint hit — returning available models`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      data: [
        { id: "claude-opus-4-6", object: "model" },
        { id: "claude-sonnet-4-5-20250929", object: "model" },
        { id: "claude-sonnet-4-20250514", object: "model" },
        { id: "claude-opus-4-5-20251101", object: "model" },
        { id: "claude-haiku-4-5", object: "model" },
      ]
    }))
    return
  }

  if (!isMessagesEndpoint) {
    console.log(`  ⚠ Unhandled path: ${url}`)
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: `Not found: ${url}. Messages API is at /v1/messages` }))
    return
  }

  if (method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Method not allowed" }))
    return
  }

  // Read request body
  let body = ""
  for await (const chunk of req) {
    body += chunk
  }

  // Log key headers for debugging
  console.log(`  Headers: anthropic-version=${req.headers["anthropic-version"] || "none"}, content-type=${req.headers["content-type"] || "none"}`)

  let anthropicReq
  try {
    anthropicReq = JSON.parse(body)
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Invalid JSON" }))
    return
  }

  const copilotModel = mapModel(anthropicReq.model)
  const isStream = anthropicReq.stream === true

  console.log(
    `→ ${anthropicReq.model} → ${copilotModel} | ${isStream ? "stream" : "sync"} | ${anthropicReq.messages?.length || 0} messages`
  )

  // Build OpenAI request
  const openaiReq = {
    model: copilotModel,
    messages: translateMessages(anthropicReq.messages, anthropicReq.system),
    max_tokens: anthropicReq.max_tokens || 4096,
    stream: isStream,
  }

  if (anthropicReq.temperature !== undefined) {
    openaiReq.temperature = anthropicReq.temperature
  }

  if (anthropicReq.top_p !== undefined) {
    openaiReq.top_p = anthropicReq.top_p
  }

  if (anthropicReq.tools) {
    openaiReq.tools = translateTools(anthropicReq.tools)
  }

  if (anthropicReq.stop_sequences) {
    openaiReq.stop = anthropicReq.stop_sequences
  }

  // Determine if there are images (for Copilot vision header)
  const hasImages = JSON.stringify(openaiReq.messages).includes("image_url")

  // Forward to Copilot
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "Openai-Intent": "conversation-edits",
    "x-initiator": "user",
  }

  if (hasImages) {
    headers["Copilot-Vision-Request"] = "true"
  }

  try {
    const copilotRes = await fetch(
      `${COPILOT_API_BASE}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(openaiReq),
      }
    )

    if (!copilotRes.ok) {
      const errorText = await copilotRes.text()
      console.error(`✗ Copilot API error: ${copilotRes.status} ${errorText}`)

      // Translate to Anthropic error format
      res.writeHead(copilotRes.status, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type:
              copilotRes.status === 401
                ? "authentication_error"
                : copilotRes.status === 429
                  ? "rate_limit_error"
                  : copilotRes.status === 403
                    ? "permission_error"
                    : "api_error",
            message: `Copilot API error (${copilotRes.status}): ${errorText}`,
          },
        })
      )
      return
    }

    if (isStream) {
      // Streaming response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      const translator = createStreamTranslator(anthropicReq.model, res)

      const reader = copilotRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()

          if (data === "[DONE]") {
            translator.processChunk("[DONE]")
            res.end()
            return
          }

          try {
            const parsed = JSON.parse(data)
            const isDone = translator.processChunk(parsed)
            if (isDone) {
              res.end()
              return
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      }

      // If we get here without [DONE], clean up
      translator.processChunk("[DONE]")
      res.end()
    } else {
      // Non-streaming response
      const openaiData = await copilotRes.json()
      const anthropicRes = translateResponseToAnthropic(
        openaiData,
        anthropicReq.model
      )

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(anthropicRes))
    }

    console.log(`  ✓ Response sent`)
  } catch (err) {
    console.error(`✗ Proxy error: ${err.message}`)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Proxy error: ${err.message}`,
        },
      })
    )
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const token = loadAuth()
console.log()
console.log("╔══════════════════════════════════════════════════════════╗")
console.log("║   GitHub Copilot Proxy for Claude Code                  ║")
console.log("╚══════════════════════════════════════════════════════════╝")
console.log()

const server = createServer((req, res) => handleRequest(req, res, token))

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ Port ${PORT} is already in use.`)
    console.error(`  Kill the existing process:  lsof -ti:${PORT} | xargs kill -9`)
    console.error(`  Or use a different port:    COPILOT_PROXY_PORT=18081 node scripts/proxy.mjs`)
  } else {
    console.error(`✗ Server error: ${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`✓ Proxy server running on http://localhost:${PORT}`)
  console.log()
  console.log("  Translates: Anthropic Messages API → Copilot Chat Completions API")
  console.log()
  console.log("  Use Claude Code with:")
  console.log(
    `  ANTHROPIC_BASE_URL=http://localhost:${PORT} ANTHROPIC_API_KEY=copilot-proxy claude`
  )
  console.log()
  console.log("  Press Ctrl+C to stop")
  console.log()
  console.log("─".repeat(60))
})

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down proxy server...")
  server.close()
  process.exit(0)
})

process.on("SIGTERM", () => {
  server.close()
  process.exit(0)
})
