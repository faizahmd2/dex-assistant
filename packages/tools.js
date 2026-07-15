const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability"); 

async function webSearch(query) {
  const res = await fetch(
    `http://localhost:8080/search?q=${encodeURIComponent(query)}&format=json`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "FaizBot/1.0",
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }

  const json = await res.json();

  // Prefer direct answers, then infoboxes
  const answers = [
    ...(json.answers ?? []).map((a) => ({
      url: a.url,
      text: a.answer,
      options: {
        source: a.engine,
      },
    })),

    ...(json.infoboxes ?? []).map((i) => ({
      url:
        i.urls?.find((u) => u.official)?.url ??
        i.urls?.[0]?.url ??
        "",
      text: i.content,
      options: {
        source: "infobox",
      },
    })),
  ]
    .filter((a) => a.url && a.text)
    .slice(0, 3);

  // Remove duplicate URLs
  const seen = new Set();

  const results = (json.results ?? [])
    .filter((r) => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map((r) => ({
      url: r.url,
      text: r.content,
      options: {
        title: r.title,
        source: r.engine,
        publishedAt: r.publishedDate || r.pubdate || null,
        score: r.score,
      },
    }));

  return {
    query,
    answers,
    results,
  };
}

async function visitWeb(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FaizBot/1.0",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch (${res.status})`);
  }

  const html = await res.text();

  const dom = new JSDOM(html, { url });

  const article = new Readability(dom.window.document).parse();

  const doc = dom.window.document;

  return {
    url,
    text: article?.textContent?.trim() ?? "",
    options: {
      title: article?.title ?? doc.title,
      description:
        doc
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") ?? null,
      publishedAt:
        doc
          .querySelector(
            'meta[property="article:published_time"],meta[name="article:published_time"],meta[name="date"]'
          )
          ?.getAttribute("content") ?? null,
      author:
        article?.byline ??
        doc.querySelector('meta[name="author"]')?.getAttribute("content") ??
        null,
      site:
        doc
          .querySelector('meta[property="og:site_name"]')
          ?.getAttribute("content") ??
        new URL(url).hostname,
      language: doc.documentElement.lang || null,
      contentType: res.headers.get("content-type"),
      wordCount:
        article?.textContent?.trim().split(/\s+/).length ?? 0,
    },
  };
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live internet. Use for current events, prices, weather, software versions, or any fact outside Faiz\'s personal data. Do NOT use for current date/time/location — that is already given to you.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'visit_web',
      description: 'Fetch full content of a specific URL (e.g. one returned by web_search) when the snippet is insufficient.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  }
]

async function runTool(name, args) {
  if (name === 'web_search') return webSearch(args.query)
  if (name === 'visit_web') return visitWeb(args.url)
  throw new Error(`Unknown tool: ${name}`)
}

module.exports = { TOOL_DEFS, runTool }