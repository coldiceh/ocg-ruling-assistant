import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

export const RULE_SYSTEMS = Object.freeze(['OCG', 'TCG']);
export function normalizeRuleSystem(value = 'OCG') {
  if (!RULE_SYSTEMS.includes(value)) throw Object.assign(new Error('Unsupported ruleSystem'),
    {code:'invalid_rule_system', statusCode:400});
  return value;
}
export function ruleSystemDataDir(ruleSystem, env = {}) {
  return normalizeRuleSystem(ruleSystem) === 'TCG'
    ? env.TCG_DATA_DIR || fileURLToPath(new URL('../data/tcg', import.meta.url))
    : undefined;
}
export function ruleSystemEnv(env, ruleSystem) {
  if (normalizeRuleSystem(ruleSystem) === 'OCG') return {...env, RAG_RULE_SYSTEM:'OCG'};
  const dataDir = ruleSystemDataDir(ruleSystem, env);
  return {...env, RAG_RULE_SYSTEM:'TCG', GEMINI_RULE_QA_DATA_DIR:dataDir, CLOUD_EVIDENCE_ASSET_DIR:join(dataDir,'cloud-evidence-v1'),
    RAG_DATA_REVISION: env.TCG_DATA_REVISION || '', RAG_LIVE_OFFICIAL_QA:'false'};
}
