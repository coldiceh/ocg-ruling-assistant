import {
  createConfiguredAdminLabRecordStore,
  exportAdminLabRecordsCsv,
  exportAdminLabRecordsJson,
} from './adminLabRecordStore.mjs';

// The hosted admin route stores only history and human ratings. Full model
// experiments remain available through the separate local composition.
export function createAdminHistoryService({ env = process.env, fetchImpl = fetch, recordStore } = {}) {
  const store = recordStore || createConfiguredAdminLabRecordStore({ env, fetchImpl });
  const unavailable = async () => {
    throw Object.assign(new Error('实验仅在本地运行；网页保留问题历史和评分。'), {
      code: 'admin_model_lab_local_only', status: 410, expose: true,
      publicMessage: '实验仅在本地运行；网页保留问题历史和评分。',
    });
  };
  function present(record) {
    return { ...record, historyOnly: true, question: record.questionSummary,
      model: record.modelConfig?.finalRuling?.model || '', configuration: record.modelConfig || {} };
  }
  async function getRun({ runId }) {
    const record = await store.getRun(runId);
    if (!record) throw Object.assign(new Error('历史记录不存在'), { code: 'admin_run_not_found', status: 404, expose: true });
    return present({ ...record, humanRating: await store.getHumanRating(runId) });
  }
  async function listRuns({ limit, cursor } = {}) {
    const page = await store.listRuns({ ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) });
    const records = page.records.map(present);
    return { ...page, records, entries: records, runs: records };
  }
  async function exportRuns({ runId, format = 'json', cursor } = {}) {
    if (!['json', 'csv'].includes(format)) throw new RangeError('Unsupported export format');
    const records = [];
    if (runId) records.push(await getRun({ runId }));
    else {
      let nextCursor = cursor;
      do { const page = await listRuns({ limit: 100, cursor: nextCursor }); records.push(...page.records); nextCursor = page.nextCursor; } while (nextCursor);
    }
    return { format, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      fileName: `ocg-history.${format}`, count: records.length,
      content: format === 'csv' ? exportAdminLabRecordsCsv(records) : exportAdminLabRecordsJson(records) };
  }
  return Object.freeze({
    historyOnly: true,
    capabilities: async () => ({ historyOnly: true, providers: [], models: [],
      features: { history: true, rating: true, export: true, createRun: false, forkRun: false,
        executeRun: false, cancelRun: false, eventReplay: false, evaluation: false,
        evidenceSnapshot: false, releaseUnchargedRelayReservation: false, reconcileRelayTotalOnlyUsage: false },
      persistence: { history: 'persistent', fullExperiments: 'local_only' } }),
    getRun, listRuns, exportRuns,
    saveRating: ({ runId, rating, notes }) => store.saveHumanRating({ runId, rating, note: notes }),
    createRun: unavailable, forkRun: unavailable, executeRun: unavailable, cancelRun: unavailable,
    pollRun: unavailable, replayEvents: unavailable, getEvaluation: unavailable,
    releaseUnchargedRelayReservation: unavailable, reconcileRelayTotalOnlyUsage: unavailable,
  });
}
