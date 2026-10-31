import * as legacy from './evidenceReadingScheduler.mjs';
import * as rrf from './evidenceReadingRrfScheduler.mjs';

// An explicit deployment setting enables RRF; legacy remains the rollback path.
export function resolveEvidenceReadingScheduler(env = process.env) {
  const policy = String(env.EVIDENCE_READING_SCHEDULER || 'legacy').trim();
  if (!['legacy', 'rrf'].includes(policy)) throw new Error('evidence_reading_scheduler_config_invalid');
  const scheduler = policy === 'rrf' ? rrf : legacy;
  return { policy, admitWholeReadingUnits: scheduler.admitWholeReadingUnits,
    contract: scheduler.READING_SCHEDULER_CONTRACT,
    priorityContract: scheduler.READING_SCHEDULER_PRIORITY_CONTRACT };
}

export function evidenceReadingSchedulerReleaseInfo(env = process.env) {
  const { policy, contract, priorityContract } = resolveEvidenceReadingScheduler(env);
  return { policy, contract, priorityContract };
}
