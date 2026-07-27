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

const INDEX_PATH = fileURLToPath(new URL('./index.js', import.meta.url));

/**
 * Categories grouped by the UTC hour they publish in.
 *
 * These groups mirror the old per-category crons (which fired at :07, :22,
 * :37 and :52 between 06:00 and 12:00 UTC), so articles still appear spread
 * across the morning instead of all at once. Order within a batch is the old
 * minute order.
 */
export const BATCHES = {
  6: ['revops', 'new_tools', 'sales', 'marketing'],
  7: ['lead_generation', 'hr_recruiting', 'it_security', 'tech_trends'],
  8: ['operations', 'strategy', 'finance', 'ai_agents'],
  9: ['workflows', 'automation', 'customer_support', 'agent_builders'],
  10: ['challenges', 'use_cases', 'growth', 'playbooks'],
  11: ['ai_humans', 'future_of_work', 'digital_labor', 'agent_economy'],
  12: ['funding', 'crypto_trading'],
};

/**
 * Resolve the list of categories to run from the environment.
 * Throws with an actionable message when the selection is missing or invalid.
 */
export function resolveCategories(env = process.env) {
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
    return list;
  }

  throw new Error(
    'Nothing to run: set NEWS_CATEGORIES (comma-separated, or "all") or NEWS_BATCH.'
  );
}

/** Run index.js for one category. Resolves to true on exit code 0. */
function runCategory(category, apiKey) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX_PATH], {
      stdio: 'inherit',
      env: { ...process.env, NEWS_CATEGORY: category, AGENT_API_KEY: apiKey },
    });
    child.on('error', (err) => {
      console.error(`[${category}] failed to start: ${err.message}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

async function main() {
  const startedAt = Date.now();
  const categories = resolveCategories();
  console.log(`Running ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}: ${categories.join(', ')}`);

  const succeeded = [];
  const failed = [];
  const skipped = [];

  for (const category of categories) {
    const apiKey = process.env[AGENT_KEY_ENV[category]];
    if (!apiKey) {
      console.warn(`[${category}] no ${AGENT_KEY_ENV[category]} in env, skipping`);
      skipped.push(category);
      continue;
    }

    console.log(`\n${'='.repeat(60)}\n[${category}] starting\n${'='.repeat(60)}`);
    const ok = await runCategory(category, apiKey);
    if (ok) {
      succeeded.push(category);
    } else {
      // Non-fatal: one bad feed or LLM hiccup shouldn't cost the whole batch.
      console.error(`[${category}] FAILED`);
      failed.push(category);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nBatch done in ${elapsedSec}s — ok=${succeeded.length} ` +
    `failed=${failed.length} skipped=${skipped.length}`
  );
  if (failed.length) console.error(`Failed categories: ${failed.join(', ')}`);

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
