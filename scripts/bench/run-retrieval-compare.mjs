#!/usr/bin/env node
// Retrieval comparison runner: answers the same question set with two arms
// that differ only in RULE_TOC_ADMIT_ENABLED (baseline=false, toc=true), and
// writes one result file per question × arm × repeat with the final answer,
// the complete evidence pack, per-call cost and stage timings. It calls the
// production pipeline directly (prepare → finalize, as the website does),
// without the HTTP route, scope check, audit/history writes or the engine
// reproduction. Nothing here judges answers; the report leaves that column
// for the user.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ARM_FLAG, ARMS, ASSUMED_DASHBOARD_ENV, FRESH_CACHE_ENV, MEMORY_LEDGER_URL, PRODUCTION_PROFILE_ID,
  UPSTASH_ENV_PAIRS, armEnv, buildBaseEnv, envDifference, maskedEnvSnapshot, missingRealModeEnv,
  readVercelProductionEnv, resolveLedgerMode,
} from "./lib/bench-env.mjs";
import { createBenchFetch } from "./lib/bench-fetch.mjs";
import { createCostTracker } from "./lib/cost-tracker.mjs";
import {
  DEFAULT_TOC_SEARCH_ROOTS, findTocIds, firstSentence, sha256Text, summarizePromptBundle,
} from "./lib/evidence-summary.mjs";
import { createMemoryLedgerStore } from "./lib/memory-ledger.mjs";
import { createMockResponder } from "./lib/mock-providers.mjs";
import {
  RESULT_SCHEMA_VERSION, eventsPath, jobKey, readJsonIfExists, resultPath, writeJsonAtomic,
} from "./lib/run-files.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_JOB_ESTIMATE_USD = 0.15;

const USAGE = `用法:
  node scripts/bench/run-retrieval-compare.mjs --set <set.json> [选项]

选项:
  --arms baseline,toc       要跑的臂（默认两臂；只差 ${ARM_FLAG}）
  --out <dir>               输出目录（默认 runs/retrieval-compare-<时间戳>）
  --concurrency <n>         并发任务数（默认 2；同一题面的任务不会同时跑）
  --budget-usd <x>          累计估算费用上限；超过即停止并写 checkpoint（真实模式必填）
  --job-estimate-usd <x>    每个任务的费用预估，用于开新任务前的预算判断（默认 ${DEFAULT_JOB_ESTIMATE_USD}）
  --resume                  续跑 --out 指定的已有目录（跳过已完成任务，累计费用从 ledger.jsonl 恢复）
  --mock                    传输层 mock：无 key、不联网，验证链路与产物格式
  --ledger auto|memory|upstash  预算账本存储（默认 auto：有 Upstash 凭据用 Upstash，否则进程内）
  --limit <n>               只跑题集前 n 题
  --qids Q1,Q5              只跑指定题号
  --repeat <n>              覆盖题集的 repeat
  --set-env KEY=VALUE       追加环境变量（可重复；两臂相同）
  --toc-path <dot.path>     ToC 选中 id 的位置（可重复，如 continuation.ruleQueryModel.bounded.ruleToc.selectedIds）
  --allow-code-change       续跑时允许代码 commit 与上次不同（会记入 manifest）
  --preflight-only          只检查配置并打印将要使用的环境，不跑任务、不发请求
`;

export function parseRunnerArgs(argv) {
  const options = { arms: ["baseline", "toc"], concurrency: 2, setEnv: {}, tocPaths: [], ledger: "auto",
    jobEstimateUsd: DEFAULT_JOB_ESTIMATE_USD };
  const valueOf = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help": case "-h": options.help = true; break;
      case "--resume": options.resume = true; break;
      case "--mock": options.mock = true; break;
      case "--preflight-only": options.preflightOnly = true; break;
      case "--allow-code-change": options.allowCodeChange = true; break;
      case "--set": options.set = valueOf(index, argument); index += 1; break;
      case "--out": options.out = valueOf(index, argument); index += 1; break;
      case "--ledger": options.ledger = valueOf(index, argument); index += 1; break;
      case "--arms":
        options.arms = valueOf(index, argument).split(",").map((arm) => arm.trim()).filter(Boolean);
        index += 1; break;
      case "--qids":
        options.qids = valueOf(index, argument).split(",").map((qid) => qid.trim()).filter(Boolean);
        index += 1; break;
      case "--concurrency": case "--limit": case "--repeat": {
        const value = Number(valueOf(index, argument));
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${argument} 必须是正整数`);
        options[argument.slice(2)] = value;
        index += 1; break;
      }
      case "--budget-usd": case "--job-estimate-usd": {
        const value = Number(valueOf(index, argument));
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${argument} 必须是正数`);
        options[argument === "--budget-usd" ? "budgetUsd" : "jobEstimateUsd"] = value;
        index += 1; break;
      }
      case "--set-env": {
        const pair = valueOf(index, argument);
        const at = pair.indexOf("=");
        if (at <= 0) throw new Error("--set-env 需要 KEY=VALUE");
        const key = pair.slice(0, at);
        if (key === ARM_FLAG) throw new Error(`${ARM_FLAG} 由 --arms 控制，不能用 --set-env 设置`);
        options.setEnv[key] = pair.slice(at + 1);
        index += 1; break;
      }
      case "--toc-path": options.tocPaths.push(valueOf(index, argument)); index += 1; break;
      default: throw new Error(`未知参数: ${argument}`);
    }
  }
  if (options.help) return options;
  if (!options.set) throw new Error("缺少 --set <题集 json>");
  for (const arm of options.arms) if (!Object.hasOwn(ARMS, arm)) throw new Error(`未知臂: ${arm}（可用 baseline,toc）`);
  if (!options.arms.length || new Set(options.arms).size !== options.arms.length) throw new Error("--arms 不能为空或重复");
  if (!options.mock && !options.budgetUsd && !options.preflightOnly) throw new Error("真实模式必须给 --budget-usd");
  if (options.mock) {
    if (options.ledger !== "auto" && options.ledger !== "memory") throw new Error("--mock 只能使用进程内账本");
    options.ledger = "memory";
    options.budgetUsd ??= 1;
  }
  if (options.resume && !options.out) throw new Error("--resume 需要 --out 指向已有运行目录");
  return options;
}

export function loadQuestionSet(file) {
  const raw = readFileSync(file, "utf8").replace(/\r\n?/gu, "\n");
  const set = JSON.parse(raw);
  const problems = [];
  if (!Array.isArray(set.items) || !set.items.length) problems.push("items 为空");
  const seen = new Set();
  for (const [index, item] of (set.items || []).entries()) {
    if (typeof item?.qid !== "string" || !item.qid.trim()) problems.push(`items[${index}].qid 为空`);
    if (seen.has(item?.qid)) problems.push(`qid 重复: ${item.qid}`);
    seen.add(item?.qid);
    if (typeof item?.question !== "string" || !item.question.trim()) problems.push(`items[${index}].question 为空`);
    if (typeof item?.referenceAnswer !== "string") problems.push(`items[${index}].referenceAnswer 必须是字符串（可为空）`);
  }
  const repeat = set.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1) problems.push("repeat 必须是正整数");
  if (problems.length) throw new Error(`题集无效 ${file}: ${problems.join("; ")}`);
  return { set, sha256: sha256Text(raw) };
}

export function planJobs({ items, arms, repeat }) {
  // Arms alternate by question (ABBA) so neither arm always runs first.
  const jobs = [];
  items.forEach((item, itemIndex) => {
    for (let r = 1; r <= repeat; r += 1) {
      const order = (itemIndex + r) % 2 === 1 ? arms : [...arms].reverse();
      for (const arm of order) {
        jobs.push({ key: jobKey({ qid: item.qid, arm, repeat: r }), qid: item.qid, cellId: item.cellId ?? null,
          arm, repeat: r, question: item.question, referenceAnswer: item.referenceAnswer });
      }
    }
  });
  return jobs;
}

function displayPath(target) {
  const relative = path.relative(process.cwd(), target);
  return !relative ? "." : relative.startsWith("..") || path.isAbsolute(relative) ? target : relative;
}

function gitFacts() {
  const run = (args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const status = run(["status", "--porcelain", "--untracked-files=no"]);
    return { commit: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: Boolean(status), dirtyFiles: status ? status.split("\n").map((line) => line.slice(3)) : [] };
  } catch {
    return { commit: null, branch: null, dirty: null, dirtyFiles: [] };
  }
}

function errorRecord(error) {
  if (!error) return null;
  return {
    name: error.name || null,
    message: String(error.message || error).slice(0, 2000),
    code: error.code || null,
    statusCode: error.statusCode ?? error.status ?? null,
    cloudCosts: error.cloudCosts || null,
    boundedRetrieval: error.boundedRetrieval ? {
      estimatedCostUsd: error.boundedRetrieval.estimatedCostUsd ?? null,
      timingsMs: error.boundedRetrieval.timingsMs || null,
      calls: (error.boundedRetrieval.calls || []).map(({ measurement, ...call }) => call),
    } : null,
    stack: String(error.stack || "").split("\n").slice(0, 8).join("\n"),
  };
}

function compactEvidenceEvent(event) {
  if (!event || typeof event !== "object") return event;
  if (event.type === "request") {
    return { type: "request", stage: event.stage, step: event.step ?? null, model: event.contract?.modelId || event.body?.model || null,
      requestSha256: event.measurement?.requestSha256 || null, body: event.body };
  }
  if (event.type === "response") return { type: "response", stage: event.stage, step: event.step ?? null, raw: event.raw };
  if (event.type === "packed") {
    return { type: "packed",
      ruleUnitIds: (event.selection?.selectedRules || []).map((rule) => rule?.id ?? null),
      qaHandles: (event.selection?.selectedQa || []).map((item) => item?.handle ?? null),
      allowedEvidenceIds: event.packing?.allowedEvidenceIds || [] };
  }
  return event;
}

// The provider's "reading" event repeats ruleQueryModel.bounded.reading
// (about 0.5 MB per job); keep one copy, in the result file.
function dedupeReadingEvents(events, continuation) {
  const reading = continuation?.ruleQueryModel?.bounded?.reading;
  if (!reading) return events;
  const serialized = JSON.stringify(reading);
  return events.map((event) => {
    if (event?.type !== "reading") return event;
    const { type, ...rest } = event;
    return JSON.stringify(rest) === serialized
      ? { type, sameAs: "results/<job>.json#prepared.continuation.ruleQueryModel.bounded.reading" } : event;
  });
}

// Mechanical identity checks: the configured production providers really ran
// (no silent fallback to a dry-run/mock path because a key was missing).
// Paid model endpoints. Every request to them must hold a budget-ledger
// ticket, otherwise its cost would be missing from the run (Gemini
// countTokens is free and is not ledgered by production).
const MODEL_HOSTS = new Set(["api.openai.com", "generativelanguage.googleapis.com", "api.b.ai",
  "api.deepseek.com", "open.bigmodel.cn", "api.siliconflow.cn", "api.moonshot.cn"]);

export function unledgeredModelRequests(network = [], calls = []) {
  const requests = network.filter((entry) => entry.route !== "ledger" && MODEL_HOSTS.has(entry.host)
    && !/:countTokens$/u.test(entry.path || "")).length;
  const tickets = calls.filter((call) => call.status !== "blocked").length;
  return { requests, tickets, ok: requests <= tickets };
}

export function integrityChecks({ continuation, final, network = [], calls = [] }) {
  const card = continuation?.cardNameModel || {};
  const rule = continuation?.ruleQueryModel || {};
  const debug = final?.debug || {};
  const coverage = unledgeredModelRequests(network, calls);
  const checks = [
    ["card_name_model_ran", card.dryRun === false, `${card.providerUsed}/${card.modelUsed}`],
    ["card_name_official_channel", card.providerUsed === "openai", String(card.providerUsed)],
    ["evidence_selector_luna", rule.evidenceSelector === "luna", String(rule.evidenceSelector)],
    ["evidence_selection_official_channel", rule.stageTelemetry?.selection?.channel === "official",
      String(rule.stageTelemetry?.selection?.channel)],
    ["evidence_generation_ran", rule.dryRun === false, String(rule.dryRun)],
    ["final_model_ran", debug.dryRun === false, String(debug.dryRun)],
    ["final_provider_openai", debug.providerUsed === "openai", String(debug.providerUsed)],
    ["final_model_astra", debug.requestedModel === "gpt-6-astra", String(debug.requestedModel)],
    ["ledger_covers_model_requests", coverage.ok, `${coverage.requests} model requests / ${coverage.tickets} ledger tickets`],
  ].map(([id, ok, observed]) => ({ id, ok: Boolean(ok), observed }));
  return { ok: checks.every((check) => check.ok), checks };
}

export function buildResultDocument({ job, attempt, run, prepared, final, error, timings, context, calls,
  jobCostUsd, tocPaths, status }) {
  const continuation = prepared?.continuation || null;
  const promptBundle = continuation?.promptBundle || null;
  const roots = { continuation, final };
  const tocSearchRoots = Object.fromEntries(DEFAULT_TOC_SEARCH_ROOTS.map((dotted) => [dotted,
    dotted.split(".").reduce((value, part) => value?.[part], roots)]));
  const tocFindings = tocPaths.length ? findTocIds(roots, tocPaths) : findTocIds(tocSearchRoots);
  const tocSelectedIds = [...new Set(tocFindings.flatMap((finding) => finding.ids))];
  const evidenceSummary = promptBundle ? summarizePromptBundle(promptBundle) : null;
  const finalAllowed = new Set(evidenceSummary?.allowedEvidenceIds || []);
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    job: { key: job.key, qid: job.qid, cellId: job.cellId, arm: job.arm, armFlag: { [ARM_FLAG]: ARMS[job.arm] },
      repeat: job.repeat, attempt },
    run: { runId: run.runId, sessionId: run.sessionId, mode: run.mode, setId: run.setId, setSha256: run.setSha256,
      codeCommit: run.git.commit, codeDirty: run.git.dirty },
    status,
    question: job.question,
    referenceAnswer: job.referenceAnswer,
    startedAt: timings.startedAt,
    completedAt: timings.completedAt,
    timingsMs: {
      wall: { prepare: timings.prepareMs, finalize: timings.finalizeMs, total: timings.totalMs },
      pipeline: continuation?.timingsMs || null,
      final: final?.debug?.timingsMs || null,
      evidenceProvider: continuation?.ruleQueryModel?.timingsMs || null,
      retrievalStages: continuation?.evidence?.debug?.timingsMs || null,
    },
    answer: final ? {
      text: final.shortAnswer ?? null,
      firstSentence: firstSentence(final.shortAnswer),
      answerLevel: final.answerLevel ?? null,
      usedEvidenceIds: (final.usedEvidence || []).map((item) => item?.id ?? null),
      riskFlags: final.riskFlags || [],
      missingInfo: final.missingInfo || [],
      modelUsed: final.debug?.modelUsed ?? null,
      requestedModel: final.debug?.requestedModel ?? null,
      returnedModel: final.debug?.returnedModel ?? null,
      providerFailure: final.debug?.providerFailure ?? null,
    } : null,
    evidence: continuation ? {
      dataRevision: continuation.dataRevision ?? null,
      evidenceFingerprint: continuation.evidenceFingerprint ?? null,
      finalPromptSha256: continuation.finalPromptSha256 ?? null,
      summary: evidenceSummary,
      // Selector output (aliases as returned); the full read/omitted group
      // lists stay in prepared.continuation.ruleQueryModel.bounded.
      selectedIds: continuation.ruleQueryModel?.bounded?.selectedIds || [],
      readGroupCount: (continuation.ruleQueryModel?.bounded?.readGroupIds || []).length,
      omittedGroupCount: (continuation.ruleQueryModel?.bounded?.omittedGroupIds || []).length,
      toc: {
        searchedPaths: tocPaths.length ? tocPaths : DEFAULT_TOC_SEARCH_ROOTS,
        findings: tocFindings,
        selectedIds: tocSelectedIds,
        inFinalPack: tocSelectedIds.filter((id) => finalAllowed.has(id)),
      },
      resolvedCards: (continuation.cardResolution?.resolvedCards || []).map((card) => ({
        id: card?.id ?? null, name: card?.name ?? null, input: card?.input ?? null })),
      unresolvedMentions: continuation.cardResolution?.unresolvedMentions || [],
      ambiguousMentions: continuation.cardResolution?.ambiguousMentions || [],
    } : null,
    cost: { totalUsd: jobCostUsd, calls,
      pipelineReported: {
        preparationCloudCosts: prepared?.debug?.cloudCosts || null,
        finalCloudCosts: final?.debug?.cloudCosts || null,
        finalTokenUsage: final?.debug?.tokenUsage || null,
        finalEstimatedCostUsd: final?.debug?.estimatedCostUsd ?? null,
      } },
    integrity: continuation && final ? integrityChecks({ continuation, final, network: context.network, calls }) : null,
    network: context.network,
    error: errorRecord(error),
    // Complete artifacts: the exact prepared continuation (prompt bundle =
    // evidence pack sent to the final model) and the final answer object.
    prepared: prepared ? { status: prepared.status ?? null, debug: prepared.debug || null, continuation } : null,
    final: final || null,
  };
}

async function main() {
  const options = parseRunnerArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const mode = options.mock ? "mock" : "real";
  const setFile = path.resolve(options.set);
  const { set, sha256: setSha256 } = loadQuestionSet(setFile);
  const runDir = path.resolve(options.out || path.join("runs",
    `retrieval-compare-${new Date().toISOString().replace(/[-:]/gu, "").replace(/\..+$/u, "")}${options.mock ? "-mock" : ""}`));
  const runId = path.basename(runDir);
  const manifestPath = path.join(runDir, "manifest.json");
  const checkpointPath = path.join(runDir, "checkpoint.json");
  const ledgerLogPath = path.join(runDir, "ledger.jsonl");
  const unattributedPath = path.join(runDir, "network-unattributed.jsonl");
  const sessionId = randomUUID();
  const git = gitFacts();

  let manifest = null;
  if (options.resume) {
    manifest = await readJsonIfExists(manifestPath);
    if (!manifest) throw new Error(`--resume: ${manifestPath} 不存在`);
    if (manifest.set.sha256 !== setSha256) throw new Error("--resume: 题集内容与原运行不同");
    if (manifest.mode !== mode) throw new Error(`--resume: 原运行是 ${manifest.mode} 模式`);
    if (JSON.stringify(manifest.arms) !== JSON.stringify(options.arms)) throw new Error("--resume: --arms 与原运行不同");
    if (manifest.git.commit !== git.commit && !options.allowCodeChange) {
      throw new Error(`--resume: 代码 commit 已从 ${manifest.git.commit} 变为 ${git.commit}；确认要混用请加 --allow-code-change`);
    }
  } else if (existsSync(runDir) && readdirSync(runDir).length) {
    throw new Error(`输出目录已存在且非空: ${runDir}（续跑请加 --resume）`);
  }

  // The arm flag reaches the pipeline only through each job's env object, as
  // every other RAG_* setting does. A value inherited by this process is
  // removed so code that read process.env directly could not make both arms
  // look switched on (the report would then show no ToC findings instead).
  const inheritedArmFlag = process.env[ARM_FLAG] ?? null;
  delete process.env[ARM_FLAG];
  const productionEnv = readVercelProductionEnv(path.join(repositoryRoot, "vercel.json"));
  const ledgerMode = options.mock ? "memory" : resolveLedgerMode(options.ledger, process.env);
  const baseEnv = buildBaseEnv({ mode, inheritedEnv: process.env, productionEnv, setEnv: options.setEnv,
    ledgerMode, runId: manifest?.runId || runId });
  if (mode === "real") {
    const missing = missingRealModeEnv(baseEnv);
    if (missing.length) throw new Error(`真实模式缺少环境变量（未发出任何请求）:\n- ${missing.join("\n- ")}`);
  }
  const ledgerUrls = ledgerMode === "memory" ? [MEMORY_LEDGER_URL]
    : UPSTASH_ENV_PAIRS.map(([url]) => baseEnv[url]).filter((value) => String(value || "").trim());

  const pricingTable = JSON.parse(readFileSync(path.join(repositoryRoot, "data/model-pricing.json"), "utf8"));
  const tracker = createCostTracker({ logPath: ledgerLogPath, budgetUsd: options.budgetUsd, pricingTable, sessionId });
  const restoredEvents = tracker.load();
  const jobContext = new AsyncLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createBenchFetch({
    mode, originalFetch, ledgerMode, ledgerUrls, tracker,
    memoryLedger: ledgerMode === "memory" ? createMemoryLedgerStore() : null,
    mockResponder: createMockResponder({ getContext: () => jobContext.getStore() }),
    getContext: () => jobContext.getStore(),
    onUnattributedNetwork: (record) => appendFileSync(unattributedPath, `${JSON.stringify(record)}\n`, "utf8"),
  });

  // Backend modules load only after fetch is routed.
  const { createPublicAnswerModelEnv } = await import("../../backend/ragModelClient.mjs");
  const { assertPublicRulingModelProfileAvailable } = await import("../../backend/publicRulingModelConfig.mjs");
  const { preloadRagRequestAssets } = await import("../../backend/ragRulingPipeline.mjs");
  const { answerRagRulingQuestionForVersion, finalizePreparedRagRulingQuestionForVersion } =
    await import("../../backend/rulingVersionRegistry.mjs");

  const envs = {};
  for (const arm of options.arms) {
    const source = armEnv(baseEnv, arm);
    assertPublicRulingModelProfileAvailable(PRODUCTION_PROFILE_ID, source);
    // Same transforms as publicAnswerService (prepare) and publicPreparedAnswerService (finalize).
    envs[arm] = {
      prepare: { ...createPublicAnswerModelEnv(source, PRODUCTION_PROFILE_ID), EVIDENCE_SELECTOR: "luna" },
      finalize: createPublicAnswerModelEnv(source, PRODUCTION_PROFILE_ID),
    };
  }
  const armDifference = options.arms.length === 2 ? {
    prepare: envDifference(envs[options.arms[0]].prepare, envs[options.arms[1]].prepare),
    finalize: envDifference(envs[options.arms[0]].finalize, envs[options.arms[1]].finalize),
  } : null;
  if (armDifference && (armDifference.prepare.join() !== ARM_FLAG || armDifference.finalize.join() !== ARM_FLAG)) {
    throw new Error(`两臂环境差异不止 ${ARM_FLAG}: ${JSON.stringify(armDifference)}`);
  }

  const items = set.items.filter((item) => !options.qids || options.qids.includes(item.qid))
    .slice(0, options.limit || undefined);
  if (!items.length) throw new Error("筛选后没有题目");
  const repeat = options.repeat ?? set.repeat ?? 1;
  const jobs = planJobs({ items, arms: options.arms, repeat });

  const session = { sessionId, startedAt: new Date().toISOString(), argv: process.argv.slice(2), git,
    restoredLedgerEvents: restoredEvents, budgetUsd: options.budgetUsd, jobEstimateUsd: options.jobEstimateUsd,
    concurrency: options.concurrency, plannedJobs: jobs.length };
  if (!manifest) {
    manifest = {
      schemaVersion: 1, runId, mode, createdAt: session.startedAt,
      set: { file: path.relative(repositoryRoot, setFile).replaceAll("\\", "/"), setId: set.setId ?? null,
        sha256: setSha256, itemCount: set.items.length, selectedQids: items.map((item) => item.qid), repeat },
      arms: options.arms, armFlag: ARM_FLAG, armValues: Object.fromEntries(options.arms.map((arm) => [arm, ARMS[arm]])),
      profile: PRODUCTION_PROFILE_ID, ledgerMode, budgetUsd: options.budgetUsd, git,
      node: process.version, platform: `${os.platform()}-${os.arch()}`,
      productionEnvSource: { file: "vercel.json", keys: Object.keys(productionEnv).sort() },
      assumedDashboardEnv: ASSUMED_DASHBOARD_ENV, freshCacheEnv: FRESH_CACHE_ENV, setEnv: options.setEnv,
      liveOfficialQa: String(baseEnv.RAG_LIVE_OFFICIAL_QA ?? "(unset: production default on)"),
      envSnapshots: Object.fromEntries(options.arms.map((arm) => [arm, {
        prepare: maskedEnvSnapshot(envs[arm].prepare), finalize: maskedEnvSnapshot(envs[arm].finalize) }])),
      armEnvDifference: armDifference,
      tocPaths: options.tocPaths,
      inheritedArmFlagRemoved: inheritedArmFlag,
      notes: [
        "直接调用 answerRagRulingQuestionForVersion(prepareForContinuation) → finalizePreparedRagRulingQuestionForVersion，与网站 prepare/finalize 两步相同；不经过 HTTP、范围检查、审计/历史写入和引擎复现。",
        "预算账本使用 bench 专用 run id；限额设为不约束值，避免影响证据组装；--budget-usd 由 runner 在账本请求处执行。",
        `${ARM_FLAG} 只通过每个任务的 env 对象传入管线；进程环境里的同名变量在启动时删除。`,
        "成本 = 账本按供应商回报 usage 结算的理论费用（gpt-6-astra 用 data/model-pricing.json；Luna/Gemini 用后端内置牌价，因该表没有这两类模型）。",
      ],
      sessions: [],
    };
  }
  manifest.sessions.push(session);
  if (options.preflightOnly) {
    console.log(JSON.stringify({ runDir, mode, ledgerMode, jobs: jobs.length, armDifference,
      envSnapshots: manifest.envSnapshots }, null, 2));
    console.log("preflight-only：未写文件、未发请求。");
    return;
  }
  await mkdir(path.join(runDir, "results"), { recursive: true });
  await writeJsonAtomic(manifestPath, manifest);

  // Warm instance: local snapshot and indexes are resident before timing starts.
  const preloadStartedAt = performance.now();
  const preloadedAssets = preloadRagRequestAssets({ env: envs[options.arms[0]].prepare, officialQaExactAlreadyChecked: true });
  if (preloadedAssets) await Promise.all([preloadedAssets.data, preloadedAssets.geminiAssets, preloadedAssets.geminiIndexes]);
  session.preloadMs = performance.now() - preloadStartedAt;

  const previous = (await readJsonIfExists(checkpointPath)) || {};
  const jobStates = { ...(previous.jobs || {}) };
  const isCompleted = (job) => {
    const existing = jobStates[job.key];
    return existing?.status === "completed" && existsSync(resultPath(runDir, job.key));
  };
  const pending = jobs.filter((job) => !isCompleted(job));
  const controller = new AbortController();
  let stopReason = null;
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    stopReason ||= "interrupted";
    if (interrupts > 1) controller.abort(new Error("bench_interrupted"));
    console.error(interrupts > 1 ? "\n再次中断：取消进行中的任务。" : "\n收到中断：不再开始新任务，等进行中的任务结束（再按一次立即取消）。");
  });

  let maxObservedJobUsd = 0;
  // Writes are chained so concurrent jobs never reorder checkpoint snapshots.
  let checkpointChain = Promise.resolve();
  const writeCheckpoint = (status) => {
    checkpointChain = checkpointChain.catch(() => {}).then(() => writeCheckpointNow(status));
    return checkpointChain;
  };
  const writeCheckpointNow = async (status) => {
    const states = Object.values(jobStates);
    await writeJsonAtomic(checkpointPath, {
      schemaVersion: 1, runId: manifest.runId, status, stopReason, updatedAt: new Date().toISOString(),
      budgetUsd: options.budgetUsd, spentUsd: tracker.spentUsd(), ledgerTickets: tracker.ticketCount(),
      plannedJobs: jobs.length,
      counts: states.reduce((counts, state) => ({ ...counts, [state.status]: (counts[state.status] || 0) + 1 }), {}),
      jobs: jobStates,
    });
  };

  const runOne = async (job) => {
    const attempt = (jobStates[job.key]?.attempts || 0) + 1;
    jobStates[job.key] = { status: "running", attempts: attempt, startedAt: new Date().toISOString() };
    await writeCheckpoint("running");
    const context = { jobKey: job.key, question: job.question, network: [], evidenceEvents: [] };
    const timings = { startedAt: new Date().toISOString() };
    let prepared = null;
    let final = null;
    let failure = null;
    tracker.activeJobs.add(job.key);
    const t0 = performance.now();
    try {
      await jobContext.run(context, async () => {
        prepared = await answerRagRulingQuestionForVersion({
          rulingVersion: "latest", question: job.question, answerLocale: "zh-CN",
          env: envs[job.arm].prepare, signal: controller.signal,
          officialQaExactAlreadyChecked: true, prepareForContinuation: true, preloadedAssets,
          nonCardElapsedBeforePipelineMs: 0,
          onEvidenceEvent: (event) => { context.evidenceEvents.push(compactEvidenceEvent(event)); },
        });
        timings.prepareMs = performance.now() - t0;
        if (prepared?.status !== "evidence_prepared") throw new Error(`prepare_returned_${prepared?.status || "unexpected_shape"}`);
        const t1 = performance.now();
        final = await finalizePreparedRagRulingQuestionForVersion({
          continuation: prepared.continuation, rulingVersion: "latest",
          env: envs[job.arm].finalize, signal: controller.signal,
        });
        timings.finalizeMs = performance.now() - t1;
      });
    } catch (error) {
      failure = error;
    } finally {
      tracker.activeJobs.delete(job.key);
    }
    timings.totalMs = performance.now() - t0;
    timings.completedAt = new Date().toISOString();
    const calls = tracker.jobCalls(job.key).filter((call) => call.sessionId === sessionId);
    const jobCostUsd = calls.reduce((sum, call) => sum + (call.status === "blocked" ? 0 : call.costUsd), 0);
    let status = failure ? "failed" : "completed";
    if (tracker.blockedJobs.has(job.key)) status = "budget_stopped";
    const document = buildResultDocument({ job, attempt, prepared, final, error: failure, timings, context, calls,
      jobCostUsd, tocPaths: options.tocPaths, status,
      run: { runId: manifest.runId, sessionId, mode, setId: set.setId ?? null, setSha256, git } });
    if (status === "completed" && document.integrity && !document.integrity.ok) {
      document.status = status = "invalid_config";
      stopReason ||= "integrity_check_failed";
    }
    await writeJsonAtomic(eventsPath(runDir, job.key), { jobKey: job.key, attempt,
      events: dedupeReadingEvents(context.evidenceEvents, prepared?.continuation) });
    await writeJsonAtomic(resultPath(runDir, job.key), document);
    jobStates[job.key] = { status, attempts: attempt, costUsd: jobCostUsd, wallMs: timings.totalMs,
      completedAt: timings.completedAt, error: failure ? String(failure.message || failure).slice(0, 300) : null };
    if (status === "completed") maxObservedJobUsd = Math.max(maxObservedJobUsd, jobCostUsd);
    if (status === "budget_stopped") stopReason ||= "budget_exceeded";
    await writeCheckpoint("running");
    const label = `${job.key}`.padEnd(22);
    console.log(`${label} ${status.padEnd(15)} ${(timings.totalMs / 1000).toFixed(1).padStart(6)}s  $${jobCostUsd.toFixed(4)}  累计 $${tracker.spentUsd().toFixed(4)}`
      + (failure ? `  ${String(failure.message || failure).slice(0, 120)}` : ""));
  };

  // Scheduler: concurrency workers, never two jobs of the same question text at
  // once (in-flight model calls of identical inputs would be shared), and a new
  // job starts only if the spent amount plus its estimate stays within budget.
  const queue = [...pending];
  const inFlight = new Map();
  const runningQuestions = new Set();
  const estimate = () => Math.max(options.jobEstimateUsd, maxObservedJobUsd);
  const admit = () => tracker.spentUsd() + (inFlight.size + 1) * estimate() <= options.budgetUsd;
  console.log(`运行目录 ${runDir}\n模式 ${mode}，账本 ${ledgerMode}，预算 $${options.budgetUsd}，`
    + `待跑 ${pending.length}/${jobs.length} 个任务，已累计 $${tracker.spentUsd().toFixed(4)}，资产预载 ${(session.preloadMs / 1000).toFixed(1)}s`);
  while (queue.length || inFlight.size) {
    if (!stopReason && tracker.budgetExceeded) stopReason = "budget_exceeded";
    let started = false;
    while (!stopReason && inFlight.size < options.concurrency) {
      const index = queue.findIndex((job) => !runningQuestions.has(job.question));
      if (index < 0) break;
      if (!admit()) {
        if (!inFlight.size) stopReason = "budget_exceeded";
        break;
      }
      const [job] = queue.splice(index, 1);
      runningQuestions.add(job.question);
      const promise = runOne(job).catch((error) => {
        jobStates[job.key] = { status: "failed", attempts: jobStates[job.key]?.attempts || 1,
          error: `runner: ${String(error?.message || error).slice(0, 300)}` };
      }).finally(() => {
        inFlight.delete(job.key);
        runningQuestions.delete(job.question);
      });
      inFlight.set(job.key, promise);
      started = true;
    }
    if (!inFlight.size) break;
    if (!started || inFlight.size >= options.concurrency || stopReason) await Promise.race(inFlight.values());
  }
  const remaining = jobs.filter((job) => jobStates[job.key]?.status !== "completed").length;
  const finalStatus = remaining === 0 ? "completed" : stopReason === "budget_exceeded" ? "budget_stopped"
    : stopReason || "incomplete";
  session.endedAt = new Date().toISOString();
  session.status = finalStatus;
  await writeJsonAtomic(manifestPath, manifest);
  await writeCheckpoint(finalStatus);
  console.log(`\n结束：${finalStatus}；完成 ${jobs.length - remaining}/${jobs.length}；累计估算费用 $${tracker.spentUsd().toFixed(4)}`
    + `（预算 $${options.budgetUsd}）\n报告：node scripts/bench/report-retrieval-compare.mjs --run ${displayPath(runDir)}`);
  if (remaining) {
    console.log(`续跑：node scripts/bench/run-retrieval-compare.mjs --set ${displayPath(setFile)} --out ${displayPath(runDir)} --resume --budget-usd <新上限>${options.mock ? " --mock" : ""}`);
    process.exitCode = finalStatus === "budget_stopped" ? 3 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
