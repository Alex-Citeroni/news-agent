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
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';

const LLM_REQUEST_TIMEOUT_MS = 90_000; // hard cap per single LLM HTTP call
const LLM_CALL_BUDGET_MS = 300_000;    // total budget per logical LLM call across all providers/retries
const MAX_LLM_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;      // cap backoff/retry-after wait — switching provider is faster
const LLM_INITIAL_BACKOFF_MS = 3000;   // base for exponential backoff on retryable errors

/**
 * Build ordered list of LLM providers.
 * Each provider has: name, client, model.
 * Providers are tried in order; unavailable ones (no API key) are skipped.
 */
export function buildProviders() {
  const providers = [];

  // Primary: Cerebras Qwen 235B (1M TPD free, 3000 tok/s, best quality)
  if (CEREBRAS_API_KEY) {
    providers.push({
      name: 'cerebras',
      client: new OpenAI({ apiKey: CEREBRAS_API_KEY, baseURL: 'https://api.cerebras.ai/v1', timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
      model: 'qwen-3-235b-a22b-instruct-2507',
    });
  }

  // Fallback 1: Groq Llama 70B (100K TPD free, fast, good quality)
  if (GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      client: new Groq({ apiKey: GROQ_API_KEY, timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
      model: 'llama-3.3-70b-versatile',
    });
  }

  // Fallback 2: Google Gemini 2.0 Flash (1500 RPD free, very reliable, native JSON mode)
  // Uses Google's OpenAI-compatible endpoint.
  if (GEMINI_API_KEY) {
    providers.push({
      name: 'gemini',
      client: new OpenAI({
        apiKey: GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        timeout: LLM_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      }),
      model: 'gemini-2.0-flash',
    });
    // Lower-tier Gemini fallback within the same provider (different quota bucket)
    providers.push({
      name: 'gemini-flash-lite',
      client: new OpenAI({
        apiKey: GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        timeout: LLM_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      }),
      model: 'gemini-2.0-flash-lite',
    });
  }

  // Fallback 3: Mistral free tier (small/medium quality, separate quota)
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

  // Fallback 4: Cerebras Llama 8B (fast but lower quality, separate quota from Qwen)
  if (CEREBRAS_API_KEY) {
    providers.push({
      name: 'cerebras-llama',
      client: new OpenAI({ apiKey: CEREBRAS_API_KEY, baseURL: 'https://api.cerebras.ai/v1', timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
      model: 'llama3.1-8b',
    });
  }

  // Last resort: OpenRouter free models (notoriously unstable: empty/truncated responses).
  // Placed last because they often return non-JSON or empty content.
  // Every model below uses the `:free` suffix — guaranteed zero cost per token.
  if (OPENROUTER_API_KEY) {
    const orClient = new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', timeout: LLM_REQUEST_TIMEOUT_MS, maxRetries: 0 });
    providers.push({
      name: 'openrouter-deepseek',
      client: orClient,
      model: 'deepseek/deepseek-chat-v3-0324:free',
    });
    providers.push({
      name: 'openrouter-llama',
      client: orClient,
      model: 'meta-llama/llama-3.3-70b-instruct:free',
    });
    providers.push({
      name: 'openrouter-gemma',
      client: orClient,
      model: 'google/gemma-3-27b-it:free',
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
  'cerebras',
  'cerebras-llama',
  'groq',
  'gemini',
  'gemini-flash-lite',
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
