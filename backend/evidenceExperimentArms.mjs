// Named evidence-retrieval experiment arms, composed from a fixed feature
// table. An arm is "baseline" or feature names joined by "+" in table order
// (nav-*, plan-*, toc), e.g. "nav-family+plan-luna+toc". Every arm sets the
// same keys; two arms differ only where their composed values differ. The
// benchmark runner reads this table; a caller names an arm but never supplies
// values of its own.

const GEMINI_PLANNING = 'gemini-3.8-flash-medium-planning-room-theoretical';
const LUNA_MEDIUM_PLANNING = 'bai-gpt-6-luna-medium-theoretical';
const LUNA_LOW_PLANNING = 'bai-gpt-6-luna-low-theoretical';

// The production configuration (vercel.json and the code defaults).
export const EVIDENCE_EXPERIMENT_BASELINE = Object.freeze({
  RULE_NAVIGATION_PARTITION: 'legacy',
  EVIDENCE_PLANNING_PROFILE: GEMINI_PLANNING,
  RULE_TOC_ADMIT_ENABLED: 'false',
});
export const EVIDENCE_EXPERIMENT_ARM_KEYS = Object.freeze(Object.keys(EVIDENCE_EXPERIMENT_BASELINE));

// Value of each arm key in a production env that does not set it.
export const EVIDENCE_EXPERIMENT_ARM_DEFAULTS = Object.freeze({
  RULE_NAVIGATION_PARTITION: 'legacy', RULE_TOC_ADMIT_ENABLED: 'false',
});

// Features of one group (the same key) are alternatives and cannot be combined.
export const EVIDENCE_EXPERIMENT_FEATURES = Object.freeze({
  'nav-unit': Object.freeze({ RULE_NAVIGATION_PARTITION: 'unit-source-kind' }),
  'nav-family': Object.freeze({ RULE_NAVIGATION_PARTITION: 'source-family' }),
  'plan-luna': Object.freeze({ EVIDENCE_PLANNING_PROFILE: LUNA_MEDIUM_PLANNING }),
  'plan-luna-low': Object.freeze({ EVIDENCE_PLANNING_PROFILE: LUNA_LOW_PLANNING }),
  toc: Object.freeze({ RULE_TOC_ADMIT_ENABLED: 'true' }),
});
const FEATURE_ORDER = Object.keys(EVIDENCE_EXPERIMENT_FEATURES);

export const DEFAULT_EVIDENCE_EXPERIMENT_ARMS = Object.freeze(['baseline', 'toc', 'nav-family', 'nav-family+toc',
  'nav-family+plan-luna', 'nav-family+plan-luna+toc']);

function armError(message) {
  return Object.assign(new Error(message), { code: 'evidence_experiment_arm_unknown', statusCode: 400 });
}

export function evidenceExperimentArm(name) {
  if (typeof name !== 'string' || !name) throw armError('unknown evidence experiment arm');
  if (name === 'baseline') return EVIDENCE_EXPERIMENT_BASELINE;
  const features = name.split('+');
  const config = { ...EVIDENCE_EXPERIMENT_BASELINE };
  const setKeys = new Set();
  for (const feature of features) {
    const values = Object.hasOwn(EVIDENCE_EXPERIMENT_FEATURES, feature) ? EVIDENCE_EXPERIMENT_FEATURES[feature] : null;
    if (!values) throw armError(`unknown evidence experiment feature: ${feature}`);
    for (const [key, value] of Object.entries(values)) {
      if (setKeys.has(key)) throw armError(`evidence experiment features set ${key} twice: ${name}`);
      setKeys.add(key);
      config[key] = value;
    }
  }
  const canonical = [...features].sort((left, right) => FEATURE_ORDER.indexOf(left) - FEATURE_ORDER.indexOf(right));
  if (canonical.join('+') !== name) throw armError(`evidence experiment arm must be written ${canonical.join('+')}`);
  return Object.freeze(config);
}

// A new env object for one job; the given env is not modified.
export function withEvidenceExperimentArm(env, name) {
  return { ...env, ...evidenceExperimentArm(name) };
}
