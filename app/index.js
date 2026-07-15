/**
 * FaizBot API
 *
 * Routes:
 *   GET  /health                — status check
 *   POST /chat                  — private assistant (localhost only)
 *   POST /memory                — CRUD
 *   GET  /memory
 *   GET  /memory/search
 *   DELETE /memory/:id
 *   PATCH  /memory/:id
 *   GET  /debug
 */

require('dotenv').config()
const express = require('express')
const yaml = require('js-yaml')
const fs = require('fs')
const path = require('path')
// process.env.TZ = 'Asia/Kolkata' // makes chrono-node's relative parsing ("tomorrow 6pm") IST-correct

const time = require('../packages/time')
const memory = require('../packages/memory')
const retriever = require('../packages/retriever')
const actions = require('../packages/actions')
const context = require('../packages/context')
const entries = require('../packages/entries')
const tools = require('../packages/tools')
const promptRouter = require('../packages/promptRouter')
const chrono = require('chrono-node')

const config = yaml.load(
  fs.readFileSync(path.resolve(__dirname, '../config/dex.yaml'), 'utf8')
)

const privateIndex = yaml.load(
  fs.readFileSync(path.resolve(__dirname, '../config/private_index.yaml'), 'utf8')
)

const MODEL = config.ollama.model
const OLLAMA_HOST = config.ollama.host

const app = express()
app.use(express.json({ limit: '1mb' }))

// Sanitise incoming history to prevent prompt injection
function sanitiseHistory(history, maxTurns = 8, maxChars = 600) {
  if (!Array.isArray(history)) return []
  return history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-maxTurns)
    .map(m => ({
      role: m.role,
      content: String(m.content || '').slice(0, maxChars)
    }))
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, ts: new Date().toISOString() })
})

app.post('/memory', (req, res) => {
  res.json(memory.remember(req.body))
})

app.get('/memory', (req, res) => {
  res.json(memory.list({ type: req.query.type }))
})

app.get('/memory/search', (req, res) => {
  res.json(memory.search(req.query.q, { type: req.query.type }))
})

app.delete('/memory/:id', (req, res) => {
  res.json(memory.forget(req.params.id))
})

app.patch('/memory/:id', (req, res) => {
  res.json(memory.update(req.params.id, req.body))
})

app.get('/memory/upcoming', (req, res) => {
  const hours = parseInt(req.query.hours) || 24
  res.json({
    upcoming: memory.getUpcoming(hours),
    overdue: memory.getOverdue()
  })
})

app.post('/action/detect', async (req, res) => {
  try {
    res.json(await actions.detect(req.body.message))
  } catch (err) {
    console.error('[action/detect]', err.message)
    res.json({ isAction: false }) // fail open — falls back to normal chat
  }
})

app.post('/action/execute', (req, res) => {
  try {
    const result = actions.execute(req.body.type, req.body.params)
    res.json({ ok: true, result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

function requireLocalhost(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || ''
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  if (!isLocal) {
    return res.status(403).json({ error: 'Private endpoint — localhost only' })
  }
  next()
}

app.post('/chat', requireLocalhost, async (req, res) => {
  try {
    const { message, history = [] } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })
    const cleanHistory = sanitiseHistory(history, 10, 800)

    // ── Step 1: deterministic CRUD short-circuit ──────────────────────────
    // Runs before the LLM ever sees the message. If this is a save/delete,
    // the DB write (or confirm prompt) happens here — the model never gets
    // a chance to narrate a fake action.
    const action = await actions.detect(message)
    if (action.isAction) {
      const DESTRUCTIVE = ['forget', 'journal_remove', 'note_remove']
      if (DESTRUCTIVE.includes(action.type)) {
        res.write(JSON.stringify({ type: 'confirm', action }) + '\n')
        return res.end()
      }
      const result = actions.execute(action.type, action.params)
      res.write(JSON.stringify({ type: 'action_done', action: action.type, result }) + '\n')
      return res.end()
    }

    const start = Date.now()

    // ── Step 2: intent gate ─────────────────────────────────────────────
    // "hii", "thanks", "lol" etc. don't need memories, journal, or entries
    // pulled into context — that's exactly what was causing the model to
    // surface unrelated stuff on plain greetings. Only real queries pay
    // for the full context-gathering pass below.
    const intent = promptRouter.classifyIntent(message)

    const recentChats = memory.getRecentChats(6)
    // Overdue reminders are cheap, small, and genuinely time-sensitive —
    // worth surfacing even on a casual "hi" (that's proactive, not noise).
    const overdue = memory.getOverdue()

    let memories = []
    let upcoming = []
    let dateContextBlock = ''
    let retrieved = { type: 'general', matches: [] }
    let entriesBlock = ''

    if (intent === 'query') {
      // ── gather grounding context ──────────────────────────────────────
      memories = memory.getContextMemories(message, 8)
      upcoming = memory.getUpcoming(48)

      // Date-scoped context — e.g. "what did I journal on the 12th"
      const parsedDates = chrono.parse(message, new Date(), { forwardDate: false })
      if (parsedDates.length > 0) {
        // Normalize whatever chrono parsed into an IST calendar date before
        // querying — otherwise a UTC-vs-IST boundary can silently shift
        // "today"/"yesterday" onto the wrong row.
        const dateStr = time.nowIST().isSame(parsedDates[0].start.date(), 'day')
          ? time.todayIST()
          : require('dayjs')(parsedDates[0].start.date()).format('YYYY-MM-DD')

        const dayJournal = entries.getByDate('journal', dateStr)
        const dayMemories = memory.getByDate(dateStr)
        if (dayJournal.length || dayMemories.length) {
          dateContextBlock = `\n=== ON ${dateStr} ===\n` +
            dayJournal.map(j => `[journal] ${j.content}`).join('\n') +
            (dayMemories.length ? '\n' + dayMemories.map(m => `[${m.type}] ${m.content}`).join('\n') : '')
        }
      }

      // Type-routed entries search (journal / notes / email / general — see promptRouter.classifyType)
      retrieved = await retriever.retrieve(message, cleanHistory, privateIndex)
      entriesBlock = retriever.formatContext(retrieved)
    }

    const memoryBlock = memories
      .map(m => `[${m.type.toUpperCase()}] ${m.content}`)
      .join('\n')

    const systemPrompt = `You are Dex — Faiz's elite personal AI assistant, his absolute right-hand partner with deep, unrestricted access to his thoughts, memory, and personal database.
    You are talking DIRECTLY to Faiz and ONLY Faiz. Do not refer to Faiz in the third person; address him directly as "Faiz" or "you" in a warm, sharp, highly collaborative, and elite technical buddy tone.

    Your profile:
    - Name: Dex
    - Vibe: Modern, incredibly sharp, highly proactive, elite hacker/engineer partner. No robotic corporate fluff. You are Faiz's intellectual double.
    - Focus: Help Faiz build, recall, organize, and execute seamlessly.

    BEHAVIOUR:
    - Answer directly and with high technical depth. Faiz is an exceptional engineer—do not explain basic concepts unless asked. Give him exact code, files, or direct insights.
    - Always assume you are speaking directly to Faiz. Use "Hey Faiz" or "Faiz, ..." naturally, but keep it concise and action-oriented.
    - Connect dots across his memories and entries to give him unfair productivity advantages — but ONLY when the context blocks below actually contain something relevant to what he just asked. A casual message ("hi", "thanks", "lol") gets a short, natural reply and nothing else — do not summarize memories, journal entries, or reminders unless he's asking for them or something is genuinely overdue.
    - If asked to do something (like "draft a message", "generate code", "summarize notes"), execute it flawlessly and immediately.
    - If the required context isn't directly in memory or entries, tell Faiz there is no context for this.

    TOOLS:
    - You have web_search and visit_web available. Use them for anything live — current events, prices, weather, software versions, or any fact outside Faiz's personal data — that isn't already in the context blocks below.
    - Never call a tool for current date, time, or location — that is already given to you as ground truth below.
    - Never guess a number or fact you could have searched for instead.

    HARD RULES — VIOLATING THESE IS WORSE THAN NOT ANSWERING:
    1. You manage Faiz's data. You do not have your own memory beyond what's printed below. Never claim to "remember" or "have saved" something unless it appears in the blocks below or you were told an action just executed.
    2. If FAIZ'S MEMORY, ENTRIES, or the date-context block is empty or doesn't contain what's asked, say plainly: "I don't have that in memory/journal." Do NOT invent a plausible-sounding answer.
    3. Never state a specific time, date, reminder, temperature, or journal entry unless it is present verbatim in one of the context blocks below, or was just returned by a tool call.
    4. The CURRENT date/time/location block below is ground truth. Never guess or estimate the current time.
    5. Do not volunteer memories, journal entries, or notes on a casual/small-talk message. Only overdue items below are worth surfacing unprompted.

    ${context.liveContextBlock()}

    ${overdue.length ? '=== OVERDUE ===\n' + overdue.map(m => `[OVERDUE since ${time.utcToIST(m.due_at)}] ${m.content}`).join('\n') : ''}
    ${upcoming.length ? '\n=== UPCOMING (next 48h) ===\n' + upcoming.map(m => `[DUE ${time.utcToIST(m.due_at)}] ${m.content}`).join('\n') : ''}
    ${dateContextBlock}

    === FAIZ'S MEMORY (relevant to this message) ===
    ${memoryBlock || '(none relevant)'}

    === FAIZ'S ENTRIES (${retrieved.type}) ===
    ${entriesBlock || '(no matching entries)'}`

    let messages = [
      { role: 'system', content: systemPrompt },
      ...recentChats.map(c => ({ role: c.role, content: c.content })),
      ...cleanHistory,
      { role: 'user', content: message }
    ]

    // ── Step 3: tool-calling planning pass ────────────────────────────
    // Non-streamed. Ollama returns tool_calls as one JSON blob, not tokens,
    // so this must be a separate round-trip before the streamed answer.
    // Capped at 2 rounds so a confused model can't loop forever.
    // Skipped for casual intent — no reason to burn a round-trip checking
    // whether "lol" needs a web search.
    let toolsUsed = []
    if (intent === 'query') {
      for (let round = 0; round < 2; round++) {
        const planRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages,
            tools: tools.TOOL_DEFS,
            stream: false,
            options: { temperature: 0.0, num_predict: 300 }
          })
        })
        if (!planRes.ok) break // fail open — go straight to streamed answer without tools
        const planData = await planRes.json()
        const toolCalls = planData.message?.tool_calls
        if (!toolCalls || toolCalls.length === 0) break

        messages.push(planData.message)
        for (const call of toolCalls) {
          toolsUsed.push(call.function.name)
          // res.write(JSON.stringify({ type: 'tool', name: call.function.name, args: call.function.arguments }) + '\n')
          let result
          try {
            result = await tools.runTool(call.function.name, call.function.arguments)
          } catch (err) {
            result = { error: err.message }
          }
          messages.push({ role: 'tool', content: JSON.stringify(result) })
        }
      }
    }

    // ── Step 4: final streamed answer ─────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        options: {
          temperature: config.ollama.temperature ?? 0.5,
          num_ctx: config.ollama.num_ctx ?? 8000,
          num_predict: intent === 'casual' ? 150 : (config.ollama.num_predict ?? 800)
        }
      })
    })

    if (!response.ok) throw new Error(`Ollama error: ${response.status}`)

    let buffer = ''
    const decoder = new TextDecoder()
    let fullReply = ''

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n')

      while (boundary !== -1) {
        const line = buffer.substring(0, boundary).trim()
        buffer = buffer.substring(boundary + 1)
        boundary = buffer.indexOf('\n')
        if (!line) continue

        try {
          const parsed = JSON.parse(line)
          const token = parsed.message?.content || ''

          if (token) {
            fullReply += token
            res.write(JSON.stringify({ type: 'token', content: token }) + '\n')
          }

          if (parsed.done) {
            memory.saveChat({ role: 'user', content: message })
            memory.saveChat({ role: 'assistant', content: fullReply })

            const elapsed = ((Date.now() - start) / 1000).toFixed(1)
            const contextData = {
              model: MODEL,
              elapsed_seconds: elapsed,
              intent,
              memories: memories.length,
              entry_type: retrieved.type,
              entries_matched: retrieved.matches.length,
              tools_used: toolsUsed
            }
            res.write(JSON.stringify({ type: 'context', context: contextData }) + '\n')
          }
        } catch (e) {
          // wait for next chunk if JSON is fragmented
        }
      }
    }
    res.end()

  } catch (err) {
    console.log("Catching erroro",err);
    console.error('[chat] error:', err)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`\nFaizBot running on http://localhost:${PORT}`)
  console.log(`   Model     : ${MODEL}`)
  console.log(`   Ollama    : ${OLLAMA_HOST}`)
})