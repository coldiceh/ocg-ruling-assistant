import {
  createDefaultLegacyLuaSemanticPacketFactory,
} from "./legacyLuaSemanticPacketFactory.mjs";

/**
 * Production composition gate. Absence of OCG_ENGINE_URL returns null before a
 * facade or fetch can be created, so an undeployed engine never causes an
 * accidental network request.
 */
export function createConfiguredLegacyLuaSemanticPacketFactory({
  env = globalThis.process?.env || {},
  fetchImpl = globalThis.fetch,
  ...options
} = {}) {
  if (!String(env?.OCG_ENGINE_URL || "").trim()) return null;
  return createDefaultLegacyLuaSemanticPacketFactory({
    env,
    fetchImpl,
    ...options,
  });
}
