/**
 * Exit codes for `index.js`, read by the batch runner.
 *
 * The runner spawns one child per category and only ever sees an exit code, so
 * the code is the only channel it has for telling "this category had a bad day"
 * apart from "the platform is refusing everything". That distinction is worth a
 * number: on 2026-09-10 the publish endpoint rejected every insert (the
 * articles `_en` columns had been dropped under it), and the batch dutifully
 * spent 644s generating four articles, translating each into two languages and
 * uploading four cover images — then threw all of it away, one category at a
 * time, against an error that could not have gone differently.
 */

/** Anything unexpected: bad feed, LLM chain exhausted, crash. */
export const EXIT_FAILED = 1;

/** The publish call itself failed after its own retries — see PUBLISH_FAILURE_ABORT_STREAK. */
export const EXIT_PUBLISH_FAILED = 2;

/**
 * How many categories in a row must fail to publish before the runner stops.
 *
 * One is a hiccup (a timeout, a 500 on one row). Two in a row, each after three
 * attempts with backoff, is the API saying no to everyone — six failed calls is
 * enough evidence, and every further category costs ~2.5 minutes of LLM work
 * and an orphaned image upload to learn the same thing.
 */
export const PUBLISH_FAILURE_ABORT_STREAK = 2;
