/**
 * Storage-only ABI for the optional precompiled card-alias artifact.
 *
 * Keeping these constants outside the legacy card extractor lets a raw-data
 * consumer authenticate a bundle that contains the artifact without loading,
 * interpreting, or hydrating the extractor's gameplay-oriented indexes.
 */
export const RAG_CARD_ALIAS_RUNTIME_INDEX_SCHEMA_VERSION = 1;
export const RAG_CARD_ALIAS_RUNTIME_INDEX_KIND = "rag-card-alias-runtime-index";
export const RAG_CARD_ALIAS_RUNTIME_INDEX_ABI = "rag-card-alias-runtime-index/v1";
