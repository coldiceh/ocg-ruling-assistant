export const RAG_DATA_UNAVAILABLE_CODE = "rag_data_unavailable";

/**
 * Stable fail-closed error for a missing or unverifiable evidence snapshot.
 *
 * The public message intentionally contains no filesystem path or bundle
 * internals. Structured diagnostics remain available to server-side logs and
 * tests through `details` and `cause`.
 */
export class RagDataUnavailableError extends Error {
  constructor({ details = {}, cause } = {}) {
    super("Ruling evidence data is temporarily unavailable", cause ? { cause } : undefined);
    this.name = "RagDataUnavailableError";
    this.code = RAG_DATA_UNAVAILABLE_CODE;
    this.statusCode = 503;
    this.status = 503;
    this.expose = true;
    this.publicMessage = "裁定资料暂时不可用，请稍后再试。";
    this.details = Object.freeze({ ...details });
  }
}

export function isRagRuntimeBundleRequired(env = process.env) {
  return /^(?:1|true|yes|on)$/iu.test(
    String(env?.RAG_RUNTIME_BUNDLE_REQUIRED || "").trim(),
  );
}
