/**
 * Shared multi-provider LLM client with retry, backoff, and fallback.
 *
 * Extracted from index.js so both the news pipeline and the social
 * engagement worker share one provider chain and one retry policy.
 *
 * Providers are tried in order; unavailable ones (no API key) are
 * skipped. On rate limit / transient error the next provider is tried.
 */

import Groq from 'groq-sdk';
import OpenAI from 'openai';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';

const LLM_REQUEST_TIMEOUT_MS = 90_000; // hard cap per single LLM HTTP call
const LLM_CALL_BUDGET_MS = 300_000;    // total budget per logical LLM call across all providers/retries
const MAX_LLM_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;      // cap backoff/retry-after wait — switching provider is faster
const LLM_INITIAL_BACKOFF_MS = 3000;   // base for exponential backoff on retryable errors

/**
 * `max_tokens` floor for calls whose visible output is short (a few queries, a
 * headline, a comment).
 *
 * It has to be far larger than the answer, because every reasoning model in the
 * chain bills its thinking against this same budget: Gemini 2.5/3.5 Flash and
 * Groq's `gpt-oss-120b` think first and emit second, so a tight cap is spent
 * before the answer starts. The failure is silent-ish and expensive — the SDK
 * returns `finish_reason: 'length'` with partial or empty content, which the
 * validator (correctly) rejects, so the call walks the whole provider chain.
 *
 * Seen on 2026-09-10 with a 400-token cap on the image-keyword call: three
 * Gemini slots returned "response truncated (max_tokens reached)" in a row and
 * Groq answered `json_validate_failed` with an empty `failed_generation` — four
 * providers burned, every run, every agent, for ~60 tokens of output.
 *
 * This is a ceiling, not an allocation: raising it costs nothing when the model
 * stops early, which is the normal case.
 */
export const SHORT_OUTPUT_MAX_TOKENS = 2048;

/**
 * Build ordered list of LLM providers.
 * Each provider has: name, client, model.
 * Providers are tried in order; unavailable ones (no API key) are skipped.
 */
export function buildProviders() {
  const providers = [];

  // Gemini entries share one endpoint but each model has its own free-tier
  // quota bucket, so stacking several genuinely multiplies daily capacity
  // instead of just re-hitting the same limit.
  const gemini = (name, model) => ({
    name,
    client: new OpenAI({
      apiKey: GEMINI_API_KEY,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      timeout: LLM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    }),
    model,
  });

  // Primary tier: Google Gemini Flash (free tier, reliable, native JSON mode).
  // `gemini-2.0-flash` / `gemini-2.0-flash-lite` were shut down and 404'd the
  // whole slot, so the first entry uses the `-latest` alias, which Google
  // hot-swaps to the current Flash release (2-week notice on breaking changes)
  // and therefore never 404s. The pinned entries below it are stable IDs that
  // each draw on a separate quota bucket.
  // Current IDs: https://ai.google.dev/gemini-api/docs/models
  if (GEMINI_API_KEY) {
    providers.push(gemini('gemini', 'gemini-flash-latest'));
    providers.push(gemini('gemini-3.5-flash', 'gemini-3.5-flash'));
    providers.push(gemini('gemini-2.5-flash', 'gemini-2.5-flash'));
  }

  // Fallback 1: Groq (very fast, but the free tier is capped at 8K tokens/min
  // and 200K/day per model — too tight to carry the primary slot for 26 agents).
  // NOTE: `llama-3.3-70b-versatile` was dropped: Groq still lists it as a
  // production model but it is no longer on the free plan, which is why it
  // returned `404 ... does not exist or you do not have access to it`.
  // qwen3.8-27b is a preview model (may be discontinued) but has its own quota.
  // Current IDs: https://console.groq.com/docs/models
  if (GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      client: new Groq({ apiKey: GROQ_API_KEY, timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
      model: 'openai/gpt-oss-120b',
    });
    providers.push({
      name: 'groq-qwen',
      client: new Groq({ apiKey: GROQ_API_KEY, timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
      model: 'qwen/qwen3.8-27b',
    });
  }

  // Fallback 2: lower-tier Gemini — smaller model, yet another quota bucket.
  if (GEMINI_API_KEY) {
    providers.push(gemini('gemini-flash-lite', 'gemini-2.5-flash-lite'));
  }

  // Fallback 3: Mistral free tier (separate quota, but rate-limits hard — it
  // 429'd on every attempt in the 2026-09-06 run, so it sits low in the chain)
  if (MISTRAL_API_KEY) {
    providers.push({
      name: 'mistral',
      client: new OpenAI({
        apiKey: MISTRAL_API_KEY,
        baseURL: 'https://api.mistral.ai/v1',
        timeout: LLM_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      }),
      model: 'mistral-small-latest',
    });
  }

  // Last resort: OpenRouter free models (notoriously unstable: empty/truncated responses).
  // Placed last because they often return non-JSON or empty content.
  // Every model below uses the `:free` suffix — guaranteed zero cost per token.
  // OpenRouter retires `:free` variants without notice (the 404 body tells you
  // to switch to the paid slug — do NOT, that would start billing). Verify with
  // `curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id | select(endswith(":free"))'`.
  if (OPENROUTER_API_KEY) {
    const orClient = new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 });
    providers.push({
      name: 'openrouter-nemotron',
      client: orClient,
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    });
    providers.push({
      // minimax-m3 lost its :free variant (2026-09); nex-n2.5-pro is free and
      // verified on JSON output the same day.
      name: 'openrouter-nex',
      client: orClient,
      model: 'nex-agi/nex-n2.5-pro:free',
    });
    providers.push({
      name: 'openrouter-gemma',
      client: orClient,
      model: 'google/gemma-4-31b-it:free',
    });
  }

  return providers;
}

export const LLM_PROVIDERS = buildProviders();

/** Whether at least one LLM provider key is configured. */
export const hasLLMProvider = LLM_PROVIDERS.length > 0;

/**
 * Extract JSON from LLM response that may contain markdown fences or extra text.
 */
export function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch { }

  // Try extracting from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { }
  }

  // Try finding the first { ... } block
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try { return JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch { }
  }

  throw new Error(`Could not extract valid JSON from response: ${text.slice(0, 200)}`);
}

/** Providers that support response_format: json_object */
const JSON_MODE_PROVIDERS = new Set([
  'gemini',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-flash-lite',
  'groq',
  'groq-qwen',
  'mistral',
]);

/**
 * Call LLM with retry, exponential backoff, and multi-provider fallback.
 * Tries each provider in order. On rate limit, moves to next provider.
 * Within each provider, retries with exponential backoff.
 *
 * Optional `validate(response)` callback runs after a successful HTTP call.
 * If it throws, the response is rejected and the next provider is tried —
 * this catches empty/truncated/malformed content that the SDK didn't reject.
 */
export async function callLLMWithRetry(params, validate) {
  let lastError = null;
  const deadline = Date.now() + LLM_CALL_BUDGET_MS;

  for (let pi = 0; pi < LLM_PROVIDERS.length; pi++) {
    if (Date.now() >= deadline) {
      console.warn(`  LLM call budget exhausted (${LLM_CALL_BUDGET_MS}ms), aborting`);
      break;
    }
    const provider = LLM_PROVIDERS[pi];

    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
      try {
        const { model, response_format, ...rest } = params;
        // Only pass response_format to providers that reliably support it
        const createParams = { ...rest, model: provider.model };
        if (response_format && JSON_MODE_PROVIDERS.has(provider.name)) {
          createParams.response_format = response_format;
        }
        const result = await provider.client.chat.completions.create(createParams);

        // Validate the response shape (e.g. non-empty content, valid JSON).
        // A validation failure is treated as a soft error — we skip to the
        // next provider rather than retrying the same one, because empty/
        // malformed responses tend to repeat from the same model.
        if (validate) {
          try {
            validate(result);
          } catch (validationErr) {
            lastError = validationErr;
            console.warn(`  ${provider.name}: invalid response (${validationErr.message}), trying next provider...`);
            break;
          }
        }

        return result;
      } catch (err) {
        lastError = err;
        const isRetryable = err.status === 429 || err.status === 503 || err.status === 502 || err.status === 504 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');

        // Non-retryable error (404, 400, auth, etc.) — skip to next provider
        if (!isRetryable) {
          console.warn(`  ${provider.name}: non-retryable error (${err.status || err.code}: ${err.message}), trying next provider...`);
          break;
        }

        const isDailyLimit = err.headers?.['x-should-retry'] === 'false'
          || err.message?.toLowerCase().includes('daily')
          || err.message?.toLowerCase().includes('tokens per day');

        // Daily limit or last retry — try next provider
        if (isDailyLimit || attempt === MAX_LLM_RETRIES) {
          console.warn(`  ${provider.name}: ${isDailyLimit ? 'daily limit reached' : 'max retries exhausted'}, trying next provider...`);
          break;
        }

        // Exponential backoff with retry-after support, clamped to remaining budget
        const retryAfterSec = parseInt(err.headers?.['retry-after'], 10) || 0;
        const backoff = LLM_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        const remaining = deadline - Date.now();
        const delay = Math.max(0, Math.min(retryAfterSec > 0 ? retryAfterSec * 1000 : backoff, MAX_RETRY_WAIT_MS, remaining));
        if (remaining <= 0) {
          console.warn(`  ${provider.name}: budget exhausted mid-retry, moving on`);
          break;
        }
        console.warn(`  ${provider.name}: attempt ${attempt} failed (${err.status || err.code}), retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error('All LLM providers failed');
}

/**
 * Build a validator that ensures the LLM returned a parsable JSON object
 * with all the required string fields. Used to skip empty/truncated/malformed
 * responses and move on to the next provider in the fallback chain.
 *
 * Called with no required fields, it just checks the content is non-empty and
 * not truncated — useful for plain-text completions.
 */
export function makeJsonContentValidator(requiredFields = []) {
  return (response) => {
    const content = response?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('empty response content');
    }
    const finishReason = response.choices[0]?.finish_reason;
    if (finishReason === 'length') {
      throw new Error('response truncated (max_tokens reached)');
    }
    if (requiredFields.length === 0) return;
    let parsed;
    try {
      parsed = extractJSON(content);
    } catch (err) {
      throw new Error(`unparsable JSON: ${err.message}`);
    }
    for (const field of requiredFields) {
      if (parsed[field] === undefined || parsed[field] === null || parsed[field] === '') {
        throw new Error(`missing required field "${field}"`);
      }
    }
  };
}
