// GPT-6 models cache every eligible prompt by default ("implicit" mode) and bill the cache write at
// 1.25x the uncached input rate. This service sends a different prompt for every question, so those
// caches were never read (OpenAI dashboard, 2026-09-28 to 10-27: cached input $0) while the writes were
// most of a normal day's charge, and the complimentary daily tokens did not cover them.
// Explicit mode with no breakpoints means a request neither uses nor writes the prompt cache
// (developers.openai.com/api/docs/guides/prompt-caching). Measured on api.openai.com on 2026-10-27:
// cache_write_tokens 1673 -> 0 on Chat Completions and 1675 -> 0 on Responses, same prompt.
// Only for api.openai.com: OpenAI-compatible relays are not known to accept this field.
export const OFFICIAL_PROMPT_CACHE_OPTIONS = Object.freeze({ mode: "explicit" });
