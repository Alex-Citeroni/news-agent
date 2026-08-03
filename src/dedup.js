/**
 * Check if an article with a similar title or same source URL was already published.
 *
 * Similarity: normalized words of length > 3 are compared; if more than 50% of the
 * new title's significant words overlap with an existing article, it's a duplicate.
 */
export function isDuplicate(newTitle, existingArticles, sourceUrl = null) {
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const newNorm = normalize(newTitle);
  const newWords = new Set(newNorm.split(/\s+/).filter((w) => w.length > 3));

  for (const article of existingArticles) {
    // Check source_url match (exact dedup across agents)
    if (sourceUrl && article.source_url && sourceUrl === article.source_url) return true;

    const existNorm = normalize(article.title);
    const existWords = new Set(existNorm.split(/\s+/).filter((w) => w.length > 3));

    // Count overlapping significant words
    let overlap = 0;
    for (const word of newWords) {
      if (existWords.has(word)) overlap++;
    }

    const similarity = newWords.size > 0 ? overlap / newWords.size : 0;
    if (similarity > 0.5) return true;
  }

  return false;
}

/**
 * Marker used to embed the source stock-photo key in the filename of a branded
 * image we upload. The published URL points at our own bucket, so without this
 * there is no way to tell which stock photo an article is already using.
 */
const SOURCE_KEY_MARKER = '-src_';

/**
 * Filename-safe form of a photo key, for embedding in a storage path.
 */
export function encodePhotoKey(key) {
  if (!key) return null;
  const safe = String(key).replace(/[^A-Za-z0-9_-]/g, '');
  return safe || null;
}

/**
 * Stable identifier for the stock photo behind an image URL, or null when the
 * URL comes from a provider we can't fingerprint.
 *
 * Handles all three shapes a published `featured_image_url` can take:
 *   - a branded image in our bucket (key embedded in the filename)
 *   - a raw Unsplash URL (branding disabled or failed)
 *   - a raw Pixabay URL
 *
 * The Unsplash/Pixabay branches derive the key from the URL rather than the
 * API's photo id so that the branded and raw forms of the same photo produce
 * the same key.
 */
export function photoKeyFromUrl(url) {
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;

  // Branded image we uploaded: <category>/<ts>-<rand>-src_<key>.jpg
  const branded = path.match(/-src_([A-Za-z0-9_-]+)\.jpe?g$/);
  if (branded) return branded[1];

  // Unsplash: /photo-1518770660439-4636190af475, /flagged/photo-…,
  // plus.unsplash.com/premium_photo-…
  const unsplash = path.match(/\/((?:premium_)?photo-[A-Za-z0-9]+-[A-Za-z0-9]+)/);
  if (unsplash) return unsplash[1];

  // Pixabay: /get/<hash>_1280.jpg — strip the size suffix so the large and
  // webformat variants of one photo collapse to the same key.
  if (parsed.hostname === 'pixabay.com' || parsed.hostname.endsWith('.pixabay.com')) {
    const base = (path.split('/').pop() || '').replace(/\.(jpe?g|png|webp)$/i, '');
    const key = encodePhotoKey(base.replace(/_\d+$/, ''));
    return key ? `px${key}` : null;
  }

  return null;
}

/**
 * Build the source-key suffix for a branded image filename. Returns '' when the
 * photo can't be fingerprinted, so the path stays valid either way.
 */
export function photoKeySuffix(key) {
  const safe = encodePhotoKey(key);
  return safe ? `${SOURCE_KEY_MARKER}${safe}` : '';
}

/**
 * Photo keys already in use by recently published articles (own + all agents).
 * Articles published before keys were embedded yield no key and are ignored.
 */
export function collectUsedPhotoKeys(articles) {
  const keys = new Set();
  for (const article of articles || []) {
    const key = photoKeyFromUrl(article?.featured_image_url);
    if (key) keys.add(key);
  }
  return keys;
}
