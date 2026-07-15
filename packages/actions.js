const memory = require('./memory')
const entries = require('./entries')
const time = require('./time')

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
const MODEL = process.env.MODEL || 'llama3.2:3b'

// Cheap keyword gate — no LLM call unless a trigger actually matches.
function detectTrigger(message) {
  const m = message.toLowerCase()
  if (/\b(forget|delete memory|remove memory)\b/.test(m)) return 'forget'
  if (/journal/.test(m)) {
    return /\b(remove|delete)\b/.test(m) ? 'journal_remove' : 'journal_add'
  }
  if (/\bnotes?\b/.test(m)) {
    return /\b(remove|delete)\b/.test(m) ? 'note_remove' : 'note_add'
  }
  if (/\b(remember this|remember that|remind me|note that|save this)\b/.test(m)) return 'remember'
  return null
}

async function extract(type, message, attempt = 0) {
  const today = time.todayIST()
  const schemas = {
    remember: `{"content": string, "due_at": "ISO datetime or null", "importance": number 1-10, "tags": string[]}`,
    journal_add: `{"date": "YYYY-MM-DD, default ${today}", "content": string}`,
    journal_remove: `{"date": "YYYY-MM-DD, default ${today}", "keyword": "short phrase to find the entry"}`,
    note_add: `{"content": string}`,
    note_remove: `{"keyword": "short phrase to find the note"}`,
    forget: `{"keyword": "short phrase to find the memory"}`
  }

  const prompt = `Extract structured data from this message for a "${type}" action.
  
  CRITICAL INSTRUCTION: Completely strip away all conversational filler, introductory meta-talk, or command prefixes. 
  For example, if the user says "create a or can you please make a journal for me that i have to read this blog", extract ONLY "i have to read this blog". Do NOT include phrases like "create a journal for me that", "remind me to", "note that", or "save this". Focus entirely on the core payload/action context.
  
  Return ONLY raw JSON matching this schema: ${schemas[type]}
  Today is ${today}.
  Message: "${message}"`

  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, prompt, stream: false, format: 'json',
      options: { temperature: 0.0, num_predict: 200 }
    }),
    signal: AbortSignal.timeout(8000)
  })
  const data = await res.json()
  const raw = data.response || ''

  try {
    return JSON.parse(raw)
  } catch (err) {
    // Small local models occasionally wrap JSON in stray text even with
    // format:'json'. Try to salvage the object before giving up, and retry
    // once — this was previously a silent, unexplained action failure.
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch (e2) { /* fall through */ }
    }
    if (attempt < 1) return extract(type, message, attempt + 1)
    throw new Error(`extract() could not parse model output for "${type}": ${raw.slice(0, 200)}`)
  }
}

async function detect(message) {
  const type = detectTrigger(message)
  if (!type) return { isAction: false }
  try {
    const params = await extract(type, message)

    if (type === 'journal_remove') {
      const match = entries.findByKeyword('journal', params.date, params.keyword)
      if (!match) return { isAction: false }
      return { isAction: true, type, params: { id: match.id },
        confirmText: `Delete this journal entry from ${params.date}?\n"${match.content}"` }
    }
    if (type === 'note_remove') {
      const match = entries.search('notes', params.keyword, 1)[0]
      if (!match) return { isAction: false }
      return { isAction: true, type, params: { id: match.id },
        confirmText: `Delete this note?\n"${match.content}"` }
    }
    if (type === 'forget') {
      const match = memory.search(params.keyword, { limit: 1 })[0]
      if (!match) return { isAction: false }
      return { isAction: true, type, params: { id: match.id },
        confirmText: `Forget this memory?\n"${match.content}"` }
    }
    if (type === 'remember') {
      return { isAction: true, type, params,
        confirmText: `Save as ${params.due_at ? 'reminder' : 'memory'}: "${params.content}"${params.due_at ? ` — due ${params.due_at}` : ''}?` }
    }
    if (type === 'journal_add') {
      return { isAction: true, type, params,
        confirmText: `Add to journal (${params.date}): "${params.content}"?` }
    }
    if (type === 'note_add') {
      return { isAction: true, type, params,
        confirmText: `Save note: "${params.content}"?` }
    }
  } catch (err) {
    console.error('[action/detect] Error extraction:', err.message)
  }
  return { isAction: false }
}

function execute(type, params) {
  switch (type) {
    case 'remember':
      if (params.due_at) params.due_at = time.istToUTC(params.due_at)
      return memory.remember(params)
    // Journal and notes both live in the shared `entries` table now, so
    // anything written here is immediately visible to retriever.retrieve()
    // and the date-context block in /chat — previously journal_add wrote
    // to a completely separate journal_entries table that nothing ever read.
    case 'journal_add': return entries.add({ type: 'journal', content: params.content, entry_date: params.date })
    case 'journal_remove': return entries.remove(params.id)
    case 'note_add': return entries.add({ type: 'notes', content: params.content })
    case 'note_remove': return entries.remove(params.id)
    case 'forget': return memory.forget(params.id)
    default: throw new Error('Unknown action type')
  }
}

module.exports = { detect, execute }