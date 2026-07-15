const entries = require('./entries')
const router = require('./promptRouter')

async function retrieve(message, history, indexConfig) {
  const type = router.classifyType(message, indexConfig)
  const matches = entries.search(type, message, 6)
  return { type, matches }
}

function formatContext({ type, matches }) {
  if (!matches.length) return ''
  return matches
    .map(e => `[${e.type}${e.entry_date ? ' · ' + e.entry_date : ''}]\n${e.content}`)
    .join('\n\n')
}

module.exports = { retrieve, formatContext }