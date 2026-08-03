/**
 * Randomness helpers shared by the news pipeline and the social worker.
 *
 * Both modules grew their own copies; the news one was
 * `sort(() => Math.random() - 0.5)`, which is NOT a shuffle — with a random
 * comparator V8 produces a heavily biased permutation (for small arrays it is
 * a binary insertion sort), so the first element stayed near the front far
 * more often than chance. Two agents searching the same stock-photo query kept
 * landing on the same picture. One correct implementation, imported by both.
 */

/** Fisher-Yates shuffle. Returns a new array; the input is left untouched. */
export function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick a random element, or undefined for an empty array. */
export function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}
