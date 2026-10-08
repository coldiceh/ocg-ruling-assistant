# Public API admission

The website and external Bot/API remain public. Request-channel labels describe
the payload format; they do not authenticate a caller.

Before paid work, `/api/answer` applies a persistent Redis sliding-window limit.
New questions and `prepare` share one bucket: 6 per minute and 30 per hour.
`finalize` allows 30 per minute and 60 per hour; source translation allows 30 per
minute and 120 per hour. Read-only `status` polling does not consume these buckets.
HTTP 429 includes `Retry-After` and `retryAfterSeconds`.

Limits use the Vercel-provided client address on Vercel and the socket address on
the local server. Forwarding headers supplied to a local server are ignored.
IPv6 addresses share their /64 network bucket. Only an HMAC-derived identity is
stored in Redis. Clients behind the same public address share limits.

Redis URL/token default to the existing Upstash configuration. Optional overrides
use `PUBLIC_REQUEST_RATE_LIMIT_REDIS_REST_URL`,
`PUBLIC_REQUEST_RATE_LIMIT_REDIS_REST_TOKEN`, `PUBLIC_REQUEST_RATE_LIMIT_HMAC_SECRET`
and `PUBLIC_REQUEST_RATE_LIMIT_NAMESPACE`. Limits use the same prefix followed by
`NEW_PER_MINUTE`, `NEW_PER_HOUR`, `FINALIZE_PER_MINUTE`, `FINALIZE_PER_HOUR`,
`TRANSLATE_PER_MINUTE` or `TRANSLATE_PER_HOUR`. A missing identity, invalid
configuration or unavailable Redis returns HTTP 503 before any paid work.

Every public new question also requires an explicit `in_scope` classifier result.
An unrelated request receives a local refusal. An uncertain or failed classifier
returns HTTP 503. Classification requires the existing server-side DeepSeek
credential; disabling the classifier does not bypass admission. A single unrelated
question no longer activates a global lock. Existing administrative locks remain
effective for answering, finalization and source translation.

Request fields are limited to `question`, `action`, `mode`, `rulingModelProfile`,
`rulingVersion`, `answerLocale` and `evidenceSelector`. Continuation and translation
actions retain their narrower field contracts. Provider credentials, prompts and
budgets cannot be supplied in a public request.

These controls reduce abuse and bound per-client request volume. They do not
authenticate users, guarantee model classification accuracy, or prevent distributed
clients from sharing many addresses. Existing daily provider budgets remain the
global spending controls.
