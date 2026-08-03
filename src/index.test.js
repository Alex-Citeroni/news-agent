import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RSS_SOURCES, getSourcesForCategory } from './rss-sources.js';
import { getAllAgents, getRssSources, AGENT_KEY_ENV } from './agents-config.js';
import { isDuplicate, photoKeyFromUrl, photoKeySuffix, collectUsedPhotoKeys } from './dedup.js';
import { BATCHES, resolveCategories } from './run-news.js';
import { shuffle, pick } from './random.js';
import {
  orderNewsItems,
  interleaveCandidates,
  selectCandidate,
  formatPhotoCredit,
  appendPhotoCredit,
  wrapHeadline,
  buildOverlaySvg,
  escapeXml,
} from './index.js';

describe('RSS Sources', () => {
  it('should have at least one default source', () => {
    assert.ok(RSS_SOURCES.length > 0, 'No default RSS sources defined');
  });

  it('each default source should have required fields', () => {
    for (const source of RSS_SOURCES) {
      assert.ok(source.name, `Source missing name`);
      assert.ok(source.url, `Source ${source.name} missing url`);
      assert.ok(source.url.startsWith('http'), `Source ${source.name} has invalid url`);
      assert.ok(Array.isArray(source.keywords), `Source ${source.name} missing keywords array`);
      assert.ok(source.keywords.length > 0, `Source ${source.name} has empty keywords`);
    }
  });

  it('getSourcesForCategory returns specialized sources', () => {
    const sources = getSourcesForCategory('crypto_trading');
    assert.ok(sources.length > 0, 'crypto_trading should have sources');
    // Should be different from default
    assert.notDeepStrictEqual(sources, RSS_SOURCES, 'crypto_trading should have specialized sources');
  });

  it('getSourcesForCategory falls back to defaults for unknown category', () => {
    const sources = getSourcesForCategory('nonexistent_category');
    assert.deepStrictEqual(sources, RSS_SOURCES, 'Unknown category should fall back to defaults');
  });
});

describe('Agents Config', () => {
  it('should have 26 agents', () => {
    const agents = getAllAgents();
    assert.strictEqual(agents.length, 26, `Expected 26 agents, got ${agents.length}`);
  });

  it('each agent should have all required fields', () => {
    const agents = getAllAgents();
    for (const agent of agents) {
      assert.ok(agent.username, `Agent missing username`);
      assert.ok(agent.display_name, `Agent ${agent.username} missing display_name`);
      assert.ok(agent.description, `Agent ${agent.username} missing description`);
      assert.ok(agent.system_prompt, `Agent ${agent.username} missing system_prompt`);
      assert.ok(agent.category, `Agent ${agent.username} missing category`);
      assert.ok(Array.isArray(agent.rss_sources), `Agent ${agent.username} missing rss_sources`);
      assert.ok(agent.rss_sources.length > 0, `Agent ${agent.username} has no rss_sources`);
    }
  });

  it('all usernames should be unique', () => {
    const agents = getAllAgents();
    const usernames = agents.map(a => a.username);
    const unique = new Set(usernames);
    assert.strictEqual(usernames.length, unique.size, 'Duplicate usernames found');
  });

  it('all categories should be unique', () => {
    const agents = getAllAgents();
    const categories = agents.map(a => a.category);
    const unique = new Set(categories);
    assert.strictEqual(categories.length, unique.size, 'Duplicate categories found');
  });

  it('each agent rss_sources should have valid structure', () => {
    const agents = getAllAgents();
    for (const agent of agents) {
      for (const source of agent.rss_sources) {
        assert.ok(source.name, `Agent ${agent.username}: source missing name`);
        assert.ok(source.url, `Agent ${agent.username}: source ${source.name} missing url`);
        assert.ok(source.url.startsWith('http'), `Agent ${agent.username}: source ${source.name} has invalid url`);
        assert.ok(Array.isArray(source.keywords), `Agent ${agent.username}: source ${source.name} missing keywords`);
        assert.ok(source.keywords.length > 0, `Agent ${agent.username}: source ${source.name} has empty keywords`);
      }
    }
  });

  it('getRssSources returns correct sources for each category', () => {
    const agents = getAllAgents();
    for (const agent of agents) {
      const sources = getRssSources(agent.category);
      assert.ok(sources, `getRssSources returned null for ${agent.category}`);
      assert.strictEqual(sources.length, agent.rss_sources.length,
        `Source count mismatch for ${agent.category}`);
    }
  });
});

describe('Duplicate Detection', () => {
  const existing = [
    { title: 'OpenAI Launches New GPT-5 Model With Advanced Reasoning', source_url: 'https://example.com/gpt5' },
    { title: 'Google DeepMind Releases Gemini 2.0 for Enterprise', source_url: 'https://example.com/gemini' },
    { title: 'AI Agents Transform Customer Service Industry', source_url: 'https://example.com/agents' },
  ];

  it('should detect exact duplicate', () => {
    assert.strictEqual(
      isDuplicate('OpenAI Launches New GPT-5 Model With Advanced Reasoning', existing),
      true
    );
  });

  it('should detect similar title', () => {
    assert.strictEqual(
      isDuplicate('OpenAI Launches GPT-5 Model With Advanced Reasoning Capabilities', existing),
      true
    );
  });

  it('should not flag unrelated article', () => {
    assert.strictEqual(
      isDuplicate('Meta Announces New Open Source LLM Called Llama 4', existing),
      false
    );
  });

  it('should handle empty existing articles', () => {
    assert.strictEqual(isDuplicate('Some New Article Title', []), false);
  });

  it('should handle short titles', () => {
    assert.strictEqual(isDuplicate('AI News', existing), false);
  });

  it('should detect duplicate by source_url', () => {
    assert.strictEqual(
      isDuplicate('Completely Different Title Here', existing, 'https://example.com/gpt5'),
      true
    );
  });

  it('should not flag different source_url', () => {
    assert.strictEqual(
      isDuplicate('Completely Different Title Here', existing, 'https://example.com/other'),
      false
    );
  });

  it('should work with null source_url', () => {
    assert.strictEqual(
      isDuplicate('Completely Different Title Here', existing, null),
      false
    );
  });
});

describe('Image Deduplication', () => {
  const UNSPLASH = 'https://images.unsplash.com/photo-1518770660439-4636190af475?ixlib=rb-4.0.3&w=1080';
  const PIXABAY = 'https://pixabay.com/get/g6f1a2b3c4d5e_1280.jpg';

  it('extracts a key from an Unsplash URL', () => {
    assert.strictEqual(photoKeyFromUrl(UNSPLASH), 'photo-1518770660439-4636190af475');
  });

  it('extracts a key from Unsplash premium and flagged URLs', () => {
    assert.strictEqual(
      photoKeyFromUrl('https://plus.unsplash.com/premium_photo-1664474619075-644dd191935f?w=1080'),
      'premium_photo-1664474619075-644dd191935f'
    );
    assert.strictEqual(
      photoKeyFromUrl('https://images.unsplash.com/flagged/photo-1551103782-8ab07afd45c1?w=1080'),
      'photo-1551103782-8ab07afd45c1'
    );
  });

  it('round-trips a premium key through a branded filename', () => {
    const key = 'premium_photo-1664474619075-644dd191935f';
    assert.strictEqual(
      photoKeyFromUrl(`https://xyz.supabase.co/storage/v1/object/public/news-images/sales/1785678475809-abc12345${photoKeySuffix(key)}.jpg`),
      key
    );
  });

  it('extracts a key from a Pixabay URL', () => {
    assert.strictEqual(photoKeyFromUrl(PIXABAY), 'pxg6f1a2b3c4d5e');
  });

  it('collapses Pixabay size variants to one key', () => {
    assert.strictEqual(
      photoKeyFromUrl('https://pixabay.com/get/g6f1a2b3c4d5e_640.jpg'),
      photoKeyFromUrl(PIXABAY)
    );
  });

  it('recovers the source key from a branded image URL', () => {
    const key = photoKeyFromUrl(UNSPLASH);
    const branded =
      `https://xyz.supabase.co/storage/v1/object/public/news-images/ai_agents/1785678475809-ri6qzj2y${photoKeySuffix(key)}.jpg`;
    assert.strictEqual(photoKeyFromUrl(branded), key);
  });

  it('returns null for branded images published before keys were embedded', () => {
    assert.strictEqual(
      photoKeyFromUrl('https://xyz.supabase.co/storage/v1/object/public/news-images/ai_agents/1785678475809-ri6qzj2y.jpg'),
      null
    );
  });

  it('returns null for missing or malformed URLs', () => {
    assert.strictEqual(photoKeyFromUrl(null), null);
    assert.strictEqual(photoKeyFromUrl(''), null);
    assert.strictEqual(photoKeyFromUrl('not a url'), null);
  });

  it('omits the suffix when the photo cannot be fingerprinted', () => {
    assert.strictEqual(photoKeySuffix(null), '');
    assert.strictEqual(photoKeySuffix(''), '');
  });

  it('collects keys across articles, ignoring unfingerprintable ones', () => {
    const keys = collectUsedPhotoKeys([
      { featured_image_url: UNSPLASH },
      { featured_image_url: PIXABAY },
      { featured_image_url: 'https://example.com/whatever.jpg' },
      { featured_image_url: null },
      {},
    ]);
    assert.deepStrictEqual(
      [...keys].sort(),
      ['photo-1518770660439-4636190af475', 'pxg6f1a2b3c4d5e']
    );
  });

  it('matches a raw stock URL against its branded counterpart', () => {
    const used = collectUsedPhotoKeys([
      { featured_image_url: `https://xyz.supabase.co/storage/v1/object/public/news-images/sales/1785678475809-abc12345${photoKeySuffix(photoKeyFromUrl(UNSPLASH))}.jpg` },
    ]);
    assert.ok(used.has(photoKeyFromUrl(UNSPLASH)), 'same photo should be recognised in both forms');
  });

  it('handles an empty article list', () => {
    assert.strictEqual(collectUsedPhotoKeys([]).size, 0);
    assert.strictEqual(collectUsedPhotoKeys(null).size, 0);
  });
});

describe('Random helpers', () => {
  it('shuffle returns a permutation without mutating the input', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input);
    assert.deepStrictEqual(input, [1, 2, 3, 4, 5], 'input must not be mutated');
    assert.deepStrictEqual([...out].sort(), [1, 2, 3, 4, 5]);
  });

  it('shuffle is unbiased enough that no position dominates', () => {
    // The bug this replaced: sort(() => Math.random() - 0.5) left the original
    // first element in front ~2x more often than chance.
    const RUNS = 20000;
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let firstStaysFirst = 0;
    for (let i = 0; i < RUNS; i++) {
      if (shuffle(pool)[0] === 0) firstStaysFirst++;
    }
    const rate = firstStaysFirst / RUNS;
    assert.ok(rate > 0.08 && rate < 0.12, `expected ~0.10, got ${rate.toFixed(3)}`);
  });

  it('shuffle handles empty and single-element arrays', () => {
    assert.deepStrictEqual(shuffle([]), []);
    assert.deepStrictEqual(shuffle(['a']), ['a']);
  });

  it('pick returns an element of the array', () => {
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) assert.ok(arr.includes(pick(arr)));
  });
});

describe('News ordering', () => {
  const item = (name, date) => ({ title: name, date });

  it('orders newer days before older ones', () => {
    const out = orderNewsItems([
      item('old', '2026-08-01T09:00:00Z'),
      item('new', '2026-08-03T09:00:00Z'),
      item('mid', '2026-08-02T09:00:00Z'),
    ]);
    assert.deepStrictEqual(out.map((i) => i.title), ['new', 'mid', 'old']);
  });

  it('keeps same-day items together but varies their order', () => {
    const sameDay = ['a', 'b', 'c', 'd', 'e'].map((n, i) =>
      item(n, `2026-08-03T0${i}:00:00Z`)
    );
    const older = item('older', '2026-07-01T09:00:00Z');

    const seen = new Set();
    for (let run = 0; run < 60; run++) {
      const out = orderNewsItems([...sameDay, older]);
      assert.strictEqual(out.length, 6);
      assert.strictEqual(out[5].title, 'older', 'older day must stay last');
      seen.add(out.slice(0, 5).map((i) => i.title).join(''));
    }
    assert.ok(seen.size > 1, 'same-day order should vary between runs');
  });

  it('sorts undated and unparsable items last', () => {
    const out = orderNewsItems([
      item('undated', ''),
      item('garbage', 'not a date'),
      item('dated', '2026-08-03T09:00:00Z'),
    ]);
    assert.strictEqual(out[0].title, 'dated');
    assert.deepStrictEqual(out.slice(1).map((i) => i.title).sort(), ['garbage', 'undated']);
  });

  it('handles an empty list', () => {
    assert.deepStrictEqual(orderNewsItems([]), []);
  });
});

describe('Image candidate selection', () => {
  const candidate = (key, url = `https://images.unsplash.com/${key}`) => ({
    url, key, source: 'Unsplash', query: 'q', author: 'A',
  });
  const allReachable = async () => true;
  const budget = () => ({ checks: 24 });

  it('interleaves the two providers', () => {
    assert.deepStrictEqual(
      interleaveCandidates(['u1', 'u2', 'u3'], ['p1']),
      ['u1', 'p1', 'u2', 'u3']
    );
    assert.deepStrictEqual(interleaveCandidates([], ['p1', 'p2']), ['p1', 'p2']);
  });

  it('takes the first reachable candidate when nothing is used', async () => {
    const { chosen } = await selectCandidate(
      [candidate('a'), candidate('b')], new Set(), allReachable, budget()
    );
    assert.strictEqual(chosen.key, 'a');
  });

  it('skips unreachable candidates', async () => {
    const isReachable = async (url) => !url.endsWith('a');
    const { chosen } = await selectCandidate(
      [candidate('a'), candidate('b')], new Set(), isReachable, budget()
    );
    assert.strictEqual(chosen.key, 'b');
  });

  it('skips photos already used by a recent article', async () => {
    const { chosen } = await selectCandidate(
      [candidate('taken'), candidate('free')], new Set(['taken']), allReachable, budget()
    );
    assert.strictEqual(chosen.key, 'free', 'must not reuse a photo another article has');
  });

  it('reports a used-but-reachable photo as the fallback', async () => {
    const { chosen, taken } = await selectCandidate(
      [candidate('taken1'), candidate('taken2')],
      new Set(['taken1', 'taken2']),
      allReachable,
      budget()
    );
    assert.strictEqual(chosen, null, 'no fresh photo available');
    assert.strictEqual(taken.key, 'taken1', 'first used-but-reachable photo is the fallback');
  });

  it('never offers an unreachable photo as the fallback', async () => {
    const { chosen, taken } = await selectCandidate(
      [candidate('taken')], new Set(['taken']), async () => false, budget()
    );
    assert.strictEqual(chosen, null);
    assert.strictEqual(taken, null);
  });

  it('stops verifying once the check budget runs out', async () => {
    let checks = 0;
    const isReachable = async () => { checks++; return false; };
    const many = Array.from({ length: 50 }, (_, i) => candidate(`k${i}`));
    const shared = { checks: 5 };

    await selectCandidate(many, new Set(), isReachable, shared);
    assert.strictEqual(checks, 5, 'must not exceed the budget');
    assert.strictEqual(shared.checks, 0, 'budget is shared across queries');
  });

  it('candidates without a key are never treated as used', async () => {
    const keyless = { url: 'https://example.com/x.jpg', key: null, source: 'Pixabay', query: 'q', author: 'A' };
    const { chosen } = await selectCandidate([keyless], new Set([null]), allReachable, budget());
    assert.strictEqual(chosen, keyless);
  });
});

describe('Photo credit', () => {
  const credit = { author: 'Jane Doe', authorUrl: 'https://unsplash.com/@jane', source: 'Unsplash' };

  it('formats the credit line per language', () => {
    assert.strictEqual(formatPhotoCredit(credit), 'Photo: Jane Doe / Unsplash (https://unsplash.com/@jane)');
    assert.strictEqual(formatPhotoCredit(credit, 'es'), 'Foto: Jane Doe / Unsplash (https://unsplash.com/@jane)');
    assert.ok(formatPhotoCredit(credit, 'zh').startsWith('图片：Jane Doe'));
  });

  it('falls back to English for an unknown language', () => {
    assert.ok(formatPhotoCredit(credit, 'fr').startsWith('Photo: '));
  });

  it('omits the link when the provider gave none', () => {
    assert.strictEqual(
      formatPhotoCredit({ author: 'Bob', authorUrl: null, source: 'Pixabay' }),
      'Photo: Bob / Pixabay'
    );
  });

  it('returns null when there is no usable author', () => {
    assert.strictEqual(formatPhotoCredit(null), null);
    assert.strictEqual(formatPhotoCredit({ author: 'unknown', source: 'Unsplash' }), null);
    assert.strictEqual(formatPhotoCredit({ author: '', source: 'Unsplash' }), null);
  });

  it('appends the credit as a trailing paragraph', () => {
    assert.strictEqual(
      appendPhotoCredit('Body text.\n\nSecond para.  ', credit, 'es'),
      'Body text.\n\nSecond para.\n\nFoto: Jane Doe / Unsplash (https://unsplash.com/@jane)'
    );
  });

  it('leaves the body untouched when there is nothing to credit', () => {
    assert.strictEqual(appendPhotoCredit('Body.', null), 'Body.');
    assert.strictEqual(appendPhotoCredit('', credit), '');
    assert.strictEqual(appendPhotoCredit(undefined, credit), undefined);
  });
});

describe('Headline overlay', () => {
  it('wraps a headline into at most maxLines', () => {
    const lines = wrapHeadline('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG TODAY', 16, 3);
    assert.ok(lines.length <= 3);
    for (const line of lines) assert.ok(line.length <= 20, `line too long: "${line}"`);
  });

  it('ellipsises a headline that does not fit', () => {
    const lines = wrapHeadline('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN', 10, 2);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].endsWith('…'), `expected ellipsis, got "${lines[1]}"`);
  });

  it('escapes XML metacharacters', () => {
    assert.strictEqual(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });

  it('produces SVG with no unescaped markup from the headline', () => {
    const svg = buildOverlaySvg({
      headline: 'AI & "AGENTS" <SCRIPT>',
      eyebrow: 'TAG & MORE',
      layout: 'bottom',
      accent: '#3B82F6',
      width: 1200,
      height: 630,
    });
    assert.ok(svg.startsWith('<svg'));
    assert.ok(!svg.includes('<SCRIPT>'), 'headline markup must be escaped');
    assert.ok(svg.includes('&amp;'), 'ampersands must be escaped');
  });

  it('supports every layout the analyzer can return', () => {
    for (const layout of ['bottom', 'top', 'left-card', 'right-card']) {
      const svg = buildOverlaySvg({
        headline: 'A HEADLINE THAT IS REASONABLY LONG',
        eyebrow: 'AI AGENTS',
        layout,
        accent: '#A855F7',
        width: 1200,
        height: 630,
      });
      assert.ok(svg.includes('</svg>'), `layout ${layout} produced no closing tag`);
      assert.ok(svg.includes('#A855F7'), `layout ${layout} dropped the accent colour`);
    }
  });
});

describe('Environment Config', () => {
  it('should have valid category options', () => {
    const validCategories = [
      'tech_trends', 'new_tools', 'sales', 'marketing', 'lead_generation',
      'operations', 'finance', 'revops', 'hr_recruiting', 'strategy',
      'it_security', 'ai_agents', 'workflows', 'automation', 'customer_support',
      'agent_builders', 'challenges', 'use_cases', 'growth', 'playbooks',
      'ai_humans', 'future_of_work', 'digital_labor', 'agent_economy',
      'funding', 'crypto_trading',
    ];
    const category = process.env.NEWS_CATEGORY || 'ai_agents';
    assert.ok(validCategories.includes(category), `Invalid category: ${category}`);
  });

  it('ARTICLES_PER_RUN should be a positive number', () => {
    const n = parseInt(process.env.ARTICLES_PER_RUN || '1', 10);
    assert.ok(n > 0 && n <= 10, `ARTICLES_PER_RUN should be 1-10, got ${n}`);
  });
});

describe('News batches', () => {
  const batched = Object.values(BATCHES).flat();

  it('covers every category exactly once', () => {
    const known = Object.keys(AGENT_KEY_ENV).sort();
    assert.deepEqual(
      [...batched].sort(),
      known,
      'BATCHES must cover every category in AGENT_KEY_ENV, with no duplicates'
    );
  });

  it('every agent has an API key env var mapped', () => {
    for (const agent of getAllAgents()) {
      assert.ok(AGENT_KEY_ENV[agent._key], `${agent._key} missing from AGENT_KEY_ENV`);
    }
  });

  it('resolveCategories reads an explicit list', () => {
    assert.deepEqual(
      resolveCategories({ NEWS_CATEGORIES: 'sales, finance' }),
      ['sales', 'finance']
    );
  });

  it('resolveCategories expands "all"', () => {
    assert.equal(resolveCategories({ NEWS_CATEGORIES: 'all' }).length, batched.length);
  });

  it('resolveCategories reads a batch key', () => {
    assert.deepEqual(resolveCategories({ NEWS_BATCH: '12' }), BATCHES[12]);
  });

  it('resolveCategories rejects unknown input', () => {
    assert.throws(() => resolveCategories({ NEWS_CATEGORIES: 'nope' }), /Unknown categories/);
    assert.throws(() => resolveCategories({ NEWS_BATCH: '99' }), /Unknown NEWS_BATCH/);
    assert.throws(() => resolveCategories({}), /Nothing to run/);
  });
});
