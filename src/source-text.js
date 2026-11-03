/**
 * The text of the story an article is written from.
 *
 * Until 2026-11 an agent wrote 300–500 words from the feed's snippet alone —
 * 500 characters of RSS — so the article could only restate the headline and
 * pad it with generic commentary. Google files that as a rewrite with nothing
 * added. Now the agent reads the source page itself, and the other coverage
 * of the same story in its feeds, and writes only from what those say.
 *
 * Paragraph extraction is deliberately simple (no DOM, no readability port):
 * news pages put their prose in <p>, and a page that yields too little text
 * is skipped rather than guessed at. The limit of that: a site that renders
 * its article only with JavaScript reads as empty, and the agent moves on to
 * the next story.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, code) => {
    const c = code.toLowerCase();
    if (c.startsWith('#x')) return String.fromCodePoint(parseInt(c.slice(2), 16));
    if (c.startsWith('#') && c !== '#39') return String.fromCodePoint(parseInt(c.slice(1), 10));
    return ENTITIES[c] ?? m;
  });
}

/** Below this a paragraph is a caption, a byline or a button label, not prose. */
const MIN_PARAGRAPH_CHARS = 60;

/** Enough of the story for the model, short enough for a free-tier context. */
export const MAX_SOURCE_CHARS = 8000;

/**
 * The prose of an article page, as paragraphs separated by blank lines.
 * Reads the <article> element when there is one (else <main>, else the body),
 * after dropping the parts of a page that are never the story.
 */
export function extractArticleText(html, maxChars = MAX_SOURCE_CHARS) {
  if (typeof html !== 'string' || !html) return '';
  let doc = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|iframe)\b[\s\S]*?<\/\1>/gi, ' ');

  // <article> first, then <main>, then the whole page: a blog can use
  // <article> for its related-post cards and keep the post itself outside.
  const scopes = [doc.match(/<article\b[\s\S]*<\/article>/i)?.[0], doc.match(/<main\b[\s\S]*<\/main>/i)?.[0], doc];
  let best = '';
  for (const scope of scopes) {
    if (!scope) continue;
    const text = paragraphsOf(scope, maxChars);
    if (text.length >= MIN_SCOPE_CHARS) return text;
    if (text.length > best.length) best = text;
  }
  return best;
}

/** A scope with less prose than this is the wrong part of the page. */
const MIN_SCOPE_CHARS = 600;

function paragraphsOf(doc, maxChars) {
  const paragraphs = [];
  let total = 0;
  for (const m of doc.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    if (paragraphs.includes(text)) continue;
    // +2 for the blank line that joins it to the previous paragraph.
    const added = text.length + (paragraphs.length ? 2 : 0);
    if (total + added > maxChars) break;
    paragraphs.push(text);
    total += added;
  }
  return paragraphs.join('\n\n');
}

const SIGNIFICANT = (title) => new Set(
  String(title).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3),
);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Other items in the pool about the same story: titles sharing at least
 * `minOverlap` of the main title's significant words, from a different
 * publisher (a second link to the same site is not a second source).
 * Best match first, one item per publisher.
 */
export function findRelatedItems(main, pool, max = 2, minOverlap = 0.3) {
  const mainWords = SIGNIFICANT(main.title);
  if (mainWords.size === 0) return [];
  const mainHost = hostOf(main.link);
  const scored = [];
  for (const item of pool) {
    if (!item?.link || item.link === main.link) continue;
    const host = hostOf(item.link);
    if (!host || host === mainHost) continue;
    const words = SIGNIFICANT(item.title);
    let overlap = 0;
    for (const w of mainWords) if (words.has(w)) overlap++;
    const score = overlap / mainWords.size;
    if (score >= minOverlap) scored.push({ item, score, host });
  }
  scored.sort((a, b) => b.score - a.score);
  const seenHosts = new Set();
  const out = [];
  for (const { item, host } of scored) {
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** Headings of the "Sources" list appended to every article, per language. */
export const SOURCES_HEADING = {
  en: 'Sources',
  es: 'Fuentes',
  zh: '来源',
  it: 'Fonti',
  fr: 'Sources',
  de: 'Quellen',
  nl: 'Bronnen',
  pl: 'Źródła',
};

/**
 * The article's sources as a markdown list, appended in code (after
 * translation) so every language carries the same links and none of them
 * goes through the model.
 */
export function formatSources(sources, lang = 'en') {
  const lines = sources
    .filter((s) => s?.link)
    .map((s) => `- [${String(s.title || s.link).replace(/[[\]]/g, '')}](${s.link})${s.source ? ` — ${s.source}` : ''}`);
  if (lines.length === 0) return '';
  return `## ${SOURCES_HEADING[lang] ?? SOURCES_HEADING.en}\n\n${lines.join('\n')}`;
}

/** Inserted before the photo credit, which stays the last line. */
export function appendSources(body, sources, lang = 'en') {
  const block = formatSources(sources, lang);
  return block ? `${body.trimEnd()}\n\n${block}` : body;
}

/**
 * The three sections every article must have. A model that skipped one wrote
 * the old shape (a restated headline and commentary), so the run retries.
 */
export const REQUIRED_SECTIONS = ['What happened', 'Why it matters', 'What to do'];

export function hasRequiredSections(body) {
  const headings = [...String(body).matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].toLowerCase());
  return REQUIRED_SECTIONS.every((s) => headings.some((h) => h.startsWith(s.toLowerCase())));
}

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; VeiiNewsBot/1.0; +https://veii.ai/editorial-standards)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
};

/** A source page shorter than this is a paywall, a cookie wall or a JS shell. */
export const MIN_SOURCE_CHARS = 1200;

/**
 * Fetch a story page and return its text, or null when it can't be read
 * (HTTP error, not HTML, too little prose). Never throws.
 */
export async function fetchSourceText(url, { fetchImpl = fetch, timeoutMs = 15_000, minChars = MIN_SOURCE_CHARS } = {}) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: PAGE_HEADERS, redirect: 'follow', signal: controller.signal });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return null;
    const text = extractArticleText(await res.text());
    return text.length >= minChars ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
