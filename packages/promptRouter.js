// Cheap, deterministic small-talk gate. If this matches, /chat skips the
// memory dump + entries retrieval entirely — no LLM call needed to decide.
const CASUAL_PATTERNS = /^\s*(hi+|hey+|hello+|yo+|sup|wassup|what'?s up|howdy|good\s?(morning|afternoon|evening|night)|thanks?( you)?|thank you|ty|ok(ay)?|k|cool|nice|lol+|haha+|bye|goodnight|gm|gn|yes|no|yep|nope|sure)\s*[!.?]*\s*$/i

// Words that, if present, mean the message is asking for something real
// even if it's short — so the short-message casual fallback below backs off.
const CONTENT_SIGNAL = /journal|remind|memory|remember|note|email|task|todo|search|find|what|when|where|who|how|why|status|context/i

function classifyIntent(message) {
  const trimmed = (message || '').trim()
  if (!trimmed) return 'casual'
  if (CASUAL_PATTERNS.test(trimmed)) return 'casual'

  // Very short, non-question messages with no content signal ("cool story",
  // "haha nice", "ok cool") — treat as casual too, without hardcoding every
  // possible greeting phrase.
  const wordCount = trimmed.split(/\s+/).length
  if (wordCount <= 3 && !/[?]/.test(trimmed) && !CONTENT_SIGNAL.test(trimmed)) {
    return 'casual'
  }

  return 'query'
}

function classifyType(message, indexConfig) {
  const m = message.toLowerCase()
  const types = indexConfig.types || {}

  if (/journal/.test(m)) return 'journal'
  if (/\bemail|inbox|mail\b/.test(m)) return 'email'
  if (/\bnotes?\b/.test(m)) return 'notes'

  // no strong signal — search default type only, don't guess further
  const defaultType = Object.entries(types).find(([, t]) => t.default)?.[0] || 'general'
  return defaultType
}

module.exports = { classifyType, classifyIntent }