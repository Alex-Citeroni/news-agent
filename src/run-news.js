/**
 * Batch runner for the news agents.
 *
 * Instead of 26 separate GitHub Actions workflows (one job per category —
 * each paying ~13s of checkout/setup overhead and each billed rounded up to
 * a full minute), a single job runs a batch of categories sequentially.
 *
 * Each category is a fresh `node src/index.js` child process: index.js reads
 * its config from env at module load and calls process.exit(), so it can't be
 * imported in a loop. A child process also isolates crashes and open handles.
 *
 * Selecting what to run (first match wins):
 *   NEWS_CATEGORIES  — comma-separated categories, or "all"
 *   NEWS_BATCH       — a batch key from BATCHES below (the UTC hour)
 *
 * Categories without their API key in env are skipped with a warning, not an
 * error — that keeps a partially-configured fork usable.
 *
 * Exit code is 1 if any category failed, 0 otherwise.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_KEY_ENV } from './agents-config.js';
import { EXIT_FAILED, EXIT_PUBLISH_FAILED, PUBLISH_FAILURE_ABORT_STREAK } from './exit-codes.js';

/*
 * The per-category child. Overridable only so the batch loop can be exercised
 * against a stub that exits with chosen codes — the abort rule below decides
 * whether the rest of a batch runs at all, and that is worth a real test rather
 * than a careful read. Nothing in production sets it.
 */
const INDEX_PATH = process.env.NEWS_INDEX_PATH
  || fileURLToPath(new URL('./index.js', import.meta.url));

/**
 * Categories grouped by the UTC hour they publish in — the ON-TOPIC ones only
 * (2026-11-25): the work VEII's apps do. The site indexes news in exactly these
 * categories (`NEWS_INDEXED_CATEGORIES` in veii's src/lib/seo/news-indexing.ts);
 * keep the two lists the same.
 *
 * Why: 27 agents publishing daily put ~23 machine-written articles a day on a
 * business-software site, half of them on robotics, crypto, funding rounds,
 * security breaches or AI policy. Google reads that volume as scaled content
 * and it blurs what the site is about. Fewer, on-topic pieces it is.
 */
export const BATCHES = {
  6: ['revops', 'new_tools', 'sales', 'marketing'],
  7: ['lead_generation', 'hr_recruiting', 'operations', 'finance'],
  8: ['ai_agents', 'workflows', 'automation', 'customer_support'],
  9: ['use_cases', 'playbooks', 'future_of_work', 'digital_labor'],
};

/**
 * Agents that still exist (their accounts, keys and past articles stay) but no
 * longer publish on a schedule. Run one by hand with NEWS_CATEGORIES if needed.
 */
export const PAUSED = [
  'it_security', 'tech_trends', 'strategy', 'agent_builders', 'challenges',
  'growth', 'ai_humans', 'agent_economy', 'funding', 'crypto_trading', 'robotics',
];

/**
 * Each scheduled category publishes every other day, alternating with its
 * neighbour in the schedule, so a batch of four puts out two a day and the
 * whole schedule ~8 a day instead of 16. Day = UTC days since the epoch.
 */
export function publishesToday(category, now = new Date()) {
  const order = Object.values(BATCHES).flat();
  const i = order.indexOf(category);
  if (i === -1) return false;
  const day = Math.floor(now.getTime() / 86_400_000);
  return (day + i) % 2 === 0;
}

/**
 * Resolve the list of categories to run from the environment.
 * Throws with an actionable message when the selection is missing or invalid.
 */
export function resolveCategories(env = process.env, now = new Date()) {
  const known = Object.keys(AGENT_KEY_ENV);
  const raw = (env.NEWS_CATEGORIES || '').trim();

  if (raw) {
    if (raw === 'all') return known;
    const list = raw.split(',').map((c) => c.trim()).filter(Boolean);
    const unknown = list.filter((c) => !known.includes(c));
    if (unknown.length) {
      throw new Error(
        `Unknown categories in NEWS_CATEGORIES: ${unknown.join(', ')}. ` +
        `Valid values: ${known.join(', ')}`
      );
    }
    return list;
  }

  const batch = (env.NEWS_BATCH || '').trim();
  if (batch) {
    const list = BATCHES[batch];
    if (!list) {
      throw new Error(
        `Unknown NEWS_BATCH "${batch}". Valid batches: ${Object.keys(BATCHES).join(', ')}`
      );
    }
    // A scheduled batch runs today's half; an explicit NEWS_CATEGORIES runs as asked.
    return list.filter((c) => publishesToday(c, now));
  }

  throw new Error(
    'Nothing to run: set NEWS_CATEGORIES (comma-separated, or "all") or NEWS_BATCH.'
  );
}

/**
 * Run index.js for one category. Resolves to the child's exit code — not a
 * boolean, because `EXIT_PUBLISH_FAILED` is what lets the loop below tell a
 * category having a bad run apart from the API refusing every category.
 */
function runCategory(category, apiKey) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX_PATH], {
      stdio: 'inherit',
      env: { ...process.env, NEWS_CATEGORY: category, AGENT_API_KEY: apiKey },
    });
    child.on('error', (err) => {
      console.error(`[${category}] failed to start: ${err.message}`);
      resolve(EXIT_FAILED);
    });
    // A child killed by a signal exits with a null code; map it onto a real
    // failure code so the streak logic below only ever compares numbers.
    child.on('close', (code) => resolve(code === null ? EXIT_FAILED : code));
  });
}

async function main() {
  const startedAt = Date.now();
  const categories = resolveCategories();
  console.log(`Running ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}: ${categories.join(', ')}`);

  const succeeded = [];
  const failed = [];
  const skipped = [];
  const notRun = [];
  let publishFailureStreak = 0;

  for (const category of categories) {
    const apiKey = process.env[AGENT_KEY_ENV[category]];
    if (!apiKey) {
      console.warn(`[${category}] no ${AGENT_KEY_ENV[category]} in env, skipping`);
      skipped.push(category);
      continue;
    }

    if (publishFailureStreak >= PUBLISH_FAILURE_ABORT_STREAK) {
      notRun.push(category);
      continue;
    }

    console.log(`\n${'='.repeat(60)}\n[${category}] starting\n${'='.repeat(60)}`);
    const code = await runCategory(category, apiKey);
    if (code === 0) {
      succeeded.push(category);
      publishFailureStreak = 0;
    } else {
      // Non-fatal: one bad feed or LLM hiccup shouldn't cost the whole batch.
      console.error(`[${category}] FAILED`);
      failed.push(category);

      // ...but a publish that keeps being refused is not a hiccup. Every
      // category writes its article, both translations and its cover image
      // BEFORE it publishes, so continuing past a dead endpoint costs ~2.5min
      // of model work and one orphaned upload per category, to be told the
      // same no. Count the streak and stop.
      publishFailureStreak = code === EXIT_PUBLISH_FAILED ? publishFailureStreak + 1 : 0;
      if (publishFailureStreak >= PUBLISH_FAILURE_ABORT_STREAK) {
        console.error(
          `\nAborting batch: ${publishFailureStreak} categories in a row could not publish. ` +
          `The article API is refusing writes — fix that and re-run.`
        );
      }
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nBatch done in ${elapsedSec}s — ok=${succeeded.length} ` +
    `failed=${failed.length} skipped=${skipped.length}` +
    (notRun.length ? ` not-run=${notRun.length}` : '')
  );
  if (failed.length) console.error(`Failed categories: ${failed.join(', ')}`);
  if (notRun.length) console.error(`Not run (batch aborted): ${notRun.join(', ')}`);

  if (succeeded.length === 0 && failed.length === 0) {
    console.error('No agent API keys found in env. Nothing to do.');
    process.exit(1);
  }
  process.exit(failed.length ? 1 : 0);
}

// Only run when executed directly, so the exports stay importable in tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
