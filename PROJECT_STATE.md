# TCG integration state

## Current task - 2026-10-13 round two, reported and stopped

Decision question: does current main's proposal/confirmation flow deliver target TCG card text and evidence-grounded answers for the original five questions?

User contract: $5 new paid ceiling includes Luna, Gemini planning/embeddings, Decisions and Astra; question scope exactly original five. Twenty-case paid evaluation, merging main, project Production environment changes and OCG Q&A in TCG evidence need user approval. Local fixes, free checks, branch push, draft PR and isolated staged/Preview are authorized. Commit as coldiceh, no AI attribution, no subagents. Historical dirty checkout D:/Documents/游戏王裁定问答 untouched.

Active tree: E:/codex-home/worktrees/tcg-source-trial/游戏王裁定问答; branch feat/tcg-ruleset; base main 1c23585d8e6463a8be909bfd5a1b25eeae3bb5e2. Source commits 737a27725b, 956f0da48f, 58ea6c2a76 and transport fix 65060fd5d2b60fc7ddebc67229daf9ad86c98bc7 are pushed. Draft PR https://github.com/coldiceh/ocg-ruling-assistant/pull/12 is attached, unmerged. GitHub/Vercel CLI login completed; no pending user device code. The absent global Git helper was not changed; push uses one-command authenticated gh helper override.

Completed implementation: exact OCG names/aliases -> stable CID -> target TCG records/text; proposal/confirmation reads target TCG text, absent targets remain unconfirmed. Preserve main's proposal/description behavior, Luna low and cleanup-off. TCG web/API ruleset and language binding, isolated data/retrieval assets, FAQ DOM context, daily snapshot workflow and 20-case question set are included. Default OCG prompts are byte equal on Chinese/English/Japanese fixed inputs, default OCG wire shape unchanged.

Completed actual local and staged five: 8/8 identities and target TCG card texts; three correct with sufficient actual inputs, two partial/incomplete because subsequent chain/timing rules were not delivered. Parent review reads question, private references, confirmed texts, actual serialized prompt and new answers; Oracle never enters online path. Paid staged tests were on commit 58ea6c2a76 at https://ocg-ruling-assistant-1ttnm8et3-coldicehs-projects.vercel.app, deployment dpl_8U8xiZrJp2Ufwd95BhqSsvJCHhkk. First four completed real API prepare/finalize. English browser prepare returned valid JSON instead of requested SSE, so UI failed before finalize. The saved original preparation was finalized once through the real streamed API; no repeated preparation. Attempted free page recovery later found the record expired.

Focused interface repair: ruleSystem was missing from web-channel body keys. Existing classifier now accepts this legal enum while preserving old bodies. Two new regression checks fail before and pass after; 52 related free tests pass. Updated staged build at https://ocg-ruling-assistant-cc9d32hf2-coldicehs-projects.vercel.app, deployment dpl_8uU3vJKgmm5LEHkkfLZsUXsGmkRf, target production with autoAssignCustomDomains=false, commit 65060fd5d2b60fc7ddebc67229daf9ad86c98bc7. Build revision passed only for this deployment; no project Production variable update. Default alias auto-assigned by CLI was restored to old main, verified independently. Main address and project default alias both resolve to dpl_8TTqpXeXadhiUsmnrCZE91CJewKK. GET release and capability API are 200. Full browser paid flow on the fix deployment was not rerun; do not claim successful end-to-end browser acceptance.

Complete fee accounting: local $0.25535430, online $0.30462351, combined $0.55997781 < $5; reservations 0, remaining $4.44002219. Original local embedding usage missing allocation $0.01638400 retained. Service cloudCosts omits Decisions; reconcile from actual ruleHints.bounded.calls added known 19 calls / $0.07060340 without new requests. Configured-rate estimates/allocations, not supplier invoices. Do not report the earlier $0.489374407 subtotal as complete.

Existing free verification: initial main/TCG full suites both have baseline failures and shared unchanged stalled test; ten introduced failures repaired, final targeted 132/135 pass and other three main also fails. Default builds and three independent TCG asset bindings passed; no paid regeneration. Manual sync 159 HTTP / 18 responses 304; 14,019 cards, 73 rule records, one FAQ parent unchanged.

Artifacts outside Git: D:/Documents/游戏王项目产物/tcg-main-trial-20261010/TCG-第二轮-预发布五题结果.md, TCG-第二轮-五题结果.md (retained local history), TCG-第二轮-20题题单.md. Private root D:\Documents\游戏王项目产物\tcg-main-trial-20261010\private\tcg-round2-20261012\; staged-parent-review.private.json, staged-http-cases, staged-cost-reconciliation.json, new-call-ledger.json, web-ruleset-contract-after.log, staged-web-fix-final.log, staged-web-fix-release.json, staged-web-fix-api-info.json, production-binding-final.private.json, production-default-alias-restored.private.json. Do not copy private prompts/references/credentials to Git.

Publication diagnostics: original Preview had obsolete model configuration and was not used for paid tests. An accidental empty project staged-source-65060fd5 was created before source archive completion, contained zero deployed files, and was deleted. One correct-project build lacked build-time commit metadata and failed; passing deployment explicitly provides its verified commit at build time. Archive/copy/build/API sessions finished, all paid requests settled, no subagents. Retain existing generated public/ and data/public-release.json dirty artifacts and exclude them from commits.

Unresolved: two chain questions require investigation of missing delivered generic rules; do not infer corpus absence or add semantic gates/card exceptions. Service cost telemetry omits Decisions, complete report already accounts it. Full browser flow on fixed deployment, broader English-name behavior, generated model navigation, OCG translation list and old shared test stall remain unverified. Twenty-case estimate $1.20-2.80 given, not authorized/executed.

Done for this authorized round: save review/report and push documentation, update draft PR, then stop. Next substantive work requires user's choice; do not merge/promote, alter project Production vars, run 20 cases, duplicate paid runs, or import OCG Q&A.

The sections below are historical, completed task boundaries.

## Active authorization superseding the older stopping points

2026-10-11: the user kept default Luna none and authorized candidate confirmation, six old contract-test updates, and an OCG-only branch based on current main. Active OCG tree: `E:/codex-home/worktrees/ocg-card-identity/游戏王裁定问答`, branch `codex/ocg-card-identity-confirmation`; main `c1d02f6483`. Search caps: two pending mentions, two actual Baige HTTP requests total, four local/four Baige entries per mention, six unique candidates per mention/twelve per question. One extra Luna call at most; no selection leaves pending.

Replay saved results first, then exactly one extraction each for original 密告 and 死亡向导, conditional confirmation included, total new ceiling $0.05; stop and report identity, final delivery and ruling correctness separately. No full-flow runs, merge or deployment. Keep TCG here; integrate the shared OCG commit without losing TCG changes. Commit as coldiceh with no AI署名; ask before merging main. Previous paid phases are completed and must be reused.

Updated: 2026-10-11 (America/New_York). Active worktree: `E:\codex-home\worktrees\tcg-source-trial\游戏王裁定问答`.
Branch: `feat/tcg-ruleset`. HEAD/shared OCG commit: `e741663820e8ea6f601d436a354eafd06de3f207`. Upstream main: `c1d02f6483` (includes Claude Responses fix `420d06b`). Prior bases: `c1d02f6483` and `8a61b5136d9e31507293322ea8aa2ccf3c451898`.

## Candidate confirmation and branch split completed; stopped

OCG-only branch `codex/ocg-card-identity-confirmation` contains shared commit `e741663820` based on latest main `c1d02f6483`. Authored/committed as coldiceh without AI署名. This feature branch now shares that commit; its remaining TCG changes stay uncommitted. Before reconciliation all 74 dirty/untracked files were hash-backed up (35,104,584 bytes) under report root `private/card-identity-confirmation-20261011/tcg-split/before`; unrelated files were retained, unchanged source lines preserve existing line endings. No main merge, push, PR or deployment.

Candidate confirmation uses original question and real names, with default Luna none. Per question caps: two pending mentions, two actual Baige searches, four local/four external rows per mention, six unique identities per mention/twelve per question, one extra Luna call. A preload result is reused; non-selections remain pending. TCG candidates borrow only OCG names/CID and read bodies from target TCG records; a selected identity absent from the target catalog stays pending. Existing TCG integration and new candidate body/absent-target mechanical checks passed (43 + 2); no live TCG or full ruling test was added.

OCG test in the independent tree completed: four saved none replies free-replayed; exactly one new initial extraction + one secondary confirmation each for original 密告 and 死亡向导. Both confirmed intended identity and have canonical local OCG text in extraction output. Generic 场地 stayed unbound. Extra phase 2986/3657 ms; configured-rate cost $0.00039105 < $0.05; four settled receipts, zero pending reservations. Final delivery/ruling correctness not_run. OCG backend hash `6bc9f6413c8a202e935f645df000f51fa25243328bc9cfc55cfa3cd737fb343d`. OCG free checks 105/107: all six authorized contract updates pass; known B2B retrieval and unchanged legacy model-role-filter assertion fail. Do not restore a semantic filter or silently update another legacy contract.

Private results/receipts/ledger/review: report root `private/card-identity-confirmation-20261011`; public report `找卡二次确认-结果.md`. Sessions `69187` (paid) and `66498` (free) finished. No background call or subagent. Done when reached: report and stop. User must decide before main merge, extra tests or further repair.

## Contract and stopping point

Reuse current main architecture for parallel OCG/TCG integration, with separate official sources, cards, indexes, revisions and caches. Preserve the default OCG prompt. Brief: `D:\Downloads\给Codex-TCG版提示词.md`.

The five-question run and first identity repair/test are completed historical evidence. The user explicitly approved round two on 2026-10-11: follow `D:\Downloads\给Codex-找卡第二轮方案.md`, complete free fixes/replay, compare four OCG inputs with Luna none/low (at most 8 new extraction dispatches), total round-two ceiling $0.3, then stop and report. “场地” remains generic; binding it to a concrete card is an error. **Do not continue into the three full-flow questions or implement second confirmation after this comparison without the next user instruction.** No commit, push, PR, Preview or deployment was made.

Do not modify historical dirty checkout `D:\Documents\游戏王裁定问答`, merge main, change Production settings, or introduce OCG Q&A/card bodies into TCG evidence. No subagents are authorized. No non-LLM semantic gate or answer-specific special case is permitted. Existing credentials remain authorized for reuse; never print them. Prior $1/$5 authorizations are finished and do not enlarge round two's $0.3 ceiling. The Oracle must never enter retrieval, selection, packing or online prompts.

## Round two completed comparison and stop (2026-10-11)

Decision question: does an explicit English-name JSON example plus all-field exact identity binding recover the four failed OCG inputs, and does low add a useful result versus none at an acceptable measured latency? Preserve the public/default none setting pending the user's choice.

- Backed up all 73 dirty/untracked files (34,318,880 bytes) before updating main. Backup: report root `private/card-identity-round2-20261011/before-main-update`; retained Git stash `8c25e757472828fa3a7108df9db4976f8cbf64ab`. Rebased to main `c1d02f6483`, including `420d06b`; resolved one preload conflict by preserving the upstream resident flag and TCG data directory. Preservation check: zero missing files; only the three upstream-modified backend files differ after mechanical CRLF normalization.
- Extraction JSON examples actually contain required `enName` and optional `jaName`/`cnName`. Parser/extractor preserve these fields. `name`, the three language fields, `originalText` and existing `canonicalNames` contribute to the same exact catalog identity binding. Multiple distinct identities stay ambiguous; no match stays unresolved. No scan union, fuzzy fix or card-specific exception.
- Temporary extraction env can pass none/low through the real transport and cache identity. Public/default none and identity selection remain unchanged. New 34-case checks: before fix 26 passes/8 failures, after fix 34 passes. Related phase/preload/risk/identity/presentation checks: 50/50.
- Saved Goblindbergh receipt was read by the new production transport/extraction entry, with zero network/model calls: 3/3 identities (9621, 9723, 5114), target TCG text projection checked. This replay did not deliver a final-model prompt or generate a ruling.
- Comparison completed: exactly 8 new extraction requests, all completed, requested/returned model `gpt-6-luna`, 800 max output tokens and a temporary 60-second timeout for both efforts. none confirmed 2/4; low confirmed 3/4. low added Tour Guide (9702), +1.9667492 seconds API time. Maxx C (9455) and full Tour Guide name (9702) confirmed in both. 密告 none output names two different wrong cards (4862/11662), correctly kept ambiguous; low retained 密告支 with empty English name, unresolved. 场地 remained generic/group-only in both. All eight supplied enName fields, six nonempty; no U+FFFD in the eight final replies. Default remains none pending user choice.
- Local resolved output carries OCG card text in the five successful combinations, but final card-text delivery and ruling correctness are **not run**. No scope, retrieval, selection or final-model request. Prior full-flow results remain unchanged.
- Configured-rate usage estimate $0.00108250, not a supplier invoice; eight settled ledger tickets, zero reserved/pending requests, below $0.3. Backend hash `233870e3d3e6560610d3d27d3d7923ccff990cad5a6347fff56bc118dff5fec1` unchanged through paid execution/replay. Private runner initially read absent early.timings instead of timingsMs; all eight raw responses were already saved. Results recovered through exact-hash offline replay with zero additional calls; original error records preserved. Paid session `53297` exited. Do not restart/import paid runners.
- Report outside Git: `D:\Documents\游戏王项目产物\tcg-main-trial-20261010\找卡第二轮-none-low对照结果.md`. Private `comparison-results.json`, `comparison-ledger.json`, `comparison-delivery-check.json`, `parent-review.json` and request/response receipts are under `private/card-identity-round2-20261011`. Windows CRLF diff check passed with cr-at-eol; default whitespace warnings did not trigger extra source formatting.

**Stopped after the comparison.** Report identity confirmation, final card-text delivery and ruling correctness separately. Candidate-based second confirmation was proposed only (up to one extra Luna call for a problem with unresolved mentions; actual search/selection latency unmeasured). No implementation or search was done. Six historical alias assertions await the chosen contract; B2B's known main failure remains outside scope. Next action: deliver the report and await the user's none/low configuration choice or next explicit instruction. Do not enter full-flow questions automatically.

## Latest paid test and stop (2026-10-11)

Completed 8 new Luna/none card-name requests and 3 full questions, using the unchanged repaired production modules locally. Other 3 TCG answers were reused unchanged. New costs: known usage at configured rates $0.10449505, missing-usage embedding allocation $0.01474560, combined estimate/allocation $0.11924065 < $1. Not a supplier invoice. 22 new requests across existing stages, 9 exact-request receipts reused; final answer calls: 2 new, 1 reused. No extra paid retry. Early budget-ledger initialization error occurred before any API dispatch, was repaired in the private runner, and cost zero.

- Actual card confirmation: 5/12 concrete mentions; 3/8 extraction questions completely confirmed. “场地” remained a group mention and never bound to a concrete card: this extra check passed.
- OCG 密告: 0/1, no 密告 text reached final input. Luna returned 密告支. Final answer leads with “usually can play a second copy” and misses the 1500-branch same-name effect-activation prohibition. Under the same-name second-copy interpretation this is incorrect/incomplete. Parent reviewed official OCG FAQ 22903 after execution; it was not injected into requests.
- TCG Goblindbergh: actual 0/3, no card texts or rules reached final input; final answer abstained. Raw response has two byte-identical JSON objects in commentary/final_answer messages, concatenated into invalid_json. Offline re-reading the saved final_answer restores 3/3 using existing parsing/catalog modules with no model call. This is a recoverable interface failure, not evidence of model identity failure; actual trial result remains 0/3.
- TCG Tour Guide: actual 2/3 (9965 and 12950); both TCG texts reached final input. Tour Guide name already has replacement characters in saved upstream response; origin not yet diagnosed. No rule text reached final input. Final answer abstained. Both TCG selectors returned UNKNOWN then NEEDS_EVIDENCE with no selected rules/QA; do not infer the corpus lacks rules or convert model status into semantic acceptance.
- Actual PROMPT_VISIBLE for all 3 cases was read by the parent. No heuristic sufficiency gate, card-specific repair or production change was added. No complete correct ruling among the 3 new full-flow questions; 2 are conservative non-answers, not definite incorrect chains.

Reports outside Git: `D:\Documents\游戏王项目产物\tcg-main-trial-20261010\找卡修复-付费小测结果.md` and `找卡修复-付费小测逐题回答.md`. Private receipts, results, parent-review.json, format-recovery-diagnostic.json and new-call-ledger.json: `private/card-identity-paid-20261011/` under that report root. Backend code hash, limits and cases are in freeze.json. Preserve all paid results; do not run the private paid runner again automatically. Stop now for the user's review.

## Latest offline card-identity repair

Remote main was checked read-only on 2026-10-11 and still equals the HEAD/base above. The preceding offline repair phase had new cost **$0** and actual model calls **0**; the subsequent authorized paid test is separately recorded above. Changes are confined to the isolated tree, with reports outside Git.

- Model `name` plus optional multilingual `canonicalNames` bind by exact normalized formal-name fields and distinct catalog identity count. Source is `model_canonical_exact`; original wording remains in `input`. No match stays unresolved; multiple identities stay ambiguous. Scan results are not unioned into a supplied model mention set.
- TCG can identify a name in OCG, then read the same CID from TCG. Ambiguous OCG identity is not settled by TCG availability. No target CID means unresolved. The bridge emits only target TCG card text and source attributes.
- The TCG snapshot schema's canonical effect body is `text`; extraction now copies it to resolved `effectText`. OCG uses its existing `effectText`. Pendulum text remains separate.
- Removed the original-surface-CID precondition for model canonical expansion; the downstream approximate-verification path no longer reverses locally bound model canonical identities. New unresolved/ambiguous model catalog results do not trigger heuristic or provider candidate substitution.
- Extraction prompts now identify the system and formal/multilingual names; one extraction stage remains. Final answer mechanically displays confirmed interpretation, e.g. `密告 → 神之密告（Solemn Accusation）`.
- Changed production files: `backend/ragCardExtractor.mjs`, `ragModelClient.mjs`, `ragEvidenceRetriever.mjs`, `ragRulingPipeline.mjs`. New test: `tests/model-canonical-card-resolution.test.mjs`; three related existing test files updated for the explicitly changed binding/presentation contract. No card-name data was edited.

Verification: initial 17-case pre-edit regression had 2 passes/15 failures. Final targeted run has **52/52 passes**, including 20 new card-identity checks and the actual extraction entry with fixed model output. No actual Luna behavior or final ruling correctness is claimed. The default final OCG prompt is byte equal to main on the same three fixed language inputs; the extraction prompt intentionally changed.

Extra legacy alias/runtime checks: **23/30 passed, 7 failed**; 4 runtime-index checks passed. Six alias assertions require the superseded local reinterpretation/scan-union behavior or unresolved canonical expansion. The legacy alias file was left unmodified, with no weakened assertions or restored semantic heuristics. The remaining B2B full-name identity failure is also present in base main: same card data, empty rule/QA sets and identity-only retrieval yield the same extraction and failed identity on both versions; see saved comparison. This existing no-model issue was not repaired in this scope.

OCG name audit: 14,424 records; 168 missing/empty `cnName`. CID 9455 still has `增殖的Z`; CID 9965 now has `影无茶骑士` in `cnName`, while its primary `name` is Japanese. Missing-field count is mechanical; only the two specified suspicious records were individually reviewed, not all translations. Full missing-name list and the unchanged data issue are in `OCG-卡名数据待核对.md`.

Report root: `D:\Documents\游戏王项目产物\tcg-main-trial-20261010`; latest report `找卡修复-离线结果.md`. Offline logs/comparisons: `private/card-identity-repair-20261011/{verification-summary.json,targeted-tests.log,ocg-prompt-comparison.json,card-name-audit.json,legacy-b2b-identity-comparison.json}`. These are separate from the five-question paid receipts and did not overwrite them.

The offline stopping point was later superseded by the explicitly authorized small paid test above. That test is finished. Do not start more fixes/tests or rerun assets/the old root trial script without the user's next instruction. Reuse saved raw receipts and the offline format recovery if a later repair is requested.

## Completed preparation and verification

- Implemented `ruleSystem` API/pipeline/continuation binding, independent directories, nickname caches and official-English card lookup. TCG disables OCG live-Q&A fallback.
- Added webpage OCG/TCG selection, request/answer labels and independent card-detail cache keys. KONAMI CID is separate from card-image passcodes.
- Added source synchronization, canonical/card-runtime builds and an isolated daily workflow that stages snapshots without paid generation or automatic publication.
- Added adapter-declared FAQ DOM ranges/context dependencies and selection/packing closure. TCG-only cleanup/final instructions address dropped rules and unsupported certainty; no semantic heuristic gate was added.
- Captured 14,019 English card records from 141 official database pages; prepared 73 rule records and one FAQ parent, including v10 rulebook, 2021 update, PSCT 1–7, Fast Effect Timing plus diagram transcription, Damage Step and the Forbidden/Limited List. Unestablished dates remain `unknown`.
- Built 378 source atoms, 102 reading units, 125 navigation inputs and 385 rule-dense units. QA-dense is intentionally empty.
- Generated 383 unique rule vector inputs after complete-input-hash lookup found zero reusable vectors/responses; estimated asset cost $0.0084188, included below. Assembled independent TCG release.
- Model navigation descriptions were **not generated**. The release uses production default records marked `not_generated_in_scope`; original titles/text and dense retrieval remain active.
- Four TCG mechanical regression files: 7 checks passed, covering system/directory binding, official card source projection, empty QA index and FAQ ranges/context closure. This does not prove semantic sufficiency or ruling correctness.
- Default OCG prompt compared with archived base main on three fixed inputs (Chinese, English, Japanese): byte equal on all three. Do not generalize to all OCG behavior.

## Historical five-question results before the identity repair

Actual local production modules used live scope/card extraction, planning, dense retrieval, Decisions selection and final models. This was not an HTTP/browser/Preview acceptance test. Card names were not frozen; reference answers/card texts were not injected. Models: b.ai GPT-6 Luna none scope/card extraction; Gemini 3.8 Flash medium theoretical planning profile; real Gemini vectors; Decisions selection; b.ai GPT-6 Astra low final answers.

| Case | Final answer and review | Wall time |
| --- | --- | ---: |
| `trigger-zone` | Correct: cannot activate after changing location before activation. Actual 2021-update evidence sufficient. | 3.679 s |
| `rivalry-reborn` | Correct: cannot activate Monster Reborn. Delivered FAQ includes negative introduction and matching example. Both identities unresolved; unnecessary card-name requests remain. | 19.014 s |
| `diff-goblindbergh` | Incomplete: explicitly insufficient evidence, no definite C2/C3. Printed rulebook p50 delivered; three card texts absent. | 24.296 s |
| `diff-tour-guide` | Incomplete: explicitly insufficient evidence with conditional explanation. Final actual prompt read in full: printed p50 delivered; three card texts and full response-timing evidence absent. | 24.907 s |
| `normal-summon-fast-window` | Correct English answer: turn player first at B, not yet open A. Delivered text/chart evidence sufficient. | 2.684 s |

Three correct conclusions and two conservative non-answers do not establish general accuracy. All eight card mentions in the three named-card questions were unresolved. The FAQ answer succeeded through matching official context despite failed card identity.

Identical full-request hashes reused saved responses. Both no-card control questions reused final responses; short wall times include cache reuse and are not cold-start latency. Five-case total about 74.58 seconds is not an online P95 estimate.

Historical FAQ context omission and printed-p50 loss did not recur in inspected samples. Both incomplete cases avoided a definite unsupported ruling. These findings apply to the samples, not the entire corpus.

## Diagnostics and unresolved production issue

The private runner initially lost the authorized Decisions credential field through `createPublicAnswerModelEnv` and omitted `BAI_CARD_ENABLED=true`. Both were corrected; final results include actual Luna extraction. Earlier `cases/` and `results.json` remain diagnostic only. Compatible responses were reused without new charges.

The historical five-question freeze failed card-name integration after those runner corrections. The offline repair addressed these causes; its later limited paid verification is recorded at the top. The historical failure mechanisms were:

- Rivalry/Reborn: Luna produced correct English `name` with Chinese `originalText`. `buildModelMentionSeeds` / `choosePrimaryModelMention` choose Chinese; English becomes `searchTexts`.
- `resolveModelExpansionByStableCidIntersection` requires a stable CID from the original surface before accepting expansion. Chinese does not bind to the English-only snapshot, so the expansion cannot confirm the card.
- Other two named-card cases returned Chinese `name`. The TCG English-name addition did not reliably constrain the existing typed contract.
- Code: `backend/ragModelClient.mjs` around 1041/5599; `backend/ragCardExtractor.mjs` around 1147; `backend/ragRulingPipeline.mjs` around 813; `backend/ragEvidenceRetriever.mjs` around 5272.

The offline production fix is made and locally checked; the original historical five answers were not relabeled as new successes. The authorized limited paid continuation is now completed above, with only two old TCG chain questions and the new OCG question executed. Other three TCG results were reused. No card-specific exceptions or evaluation-reference injection.

English named-card usability, wider coverage, generated navigation, all OCG behavior and deployed performance remain unverified. Abbreviations are limited to MST/ROTA/DAD. The diagram is a human transcription and needs review when its official image changes. Daily workflow stages snapshots only.

## Cost and reusable artifacts

Known usage times configured prices estimates **$0.45345585**. Query-embedding responses lack usable billing usage; **$0.04096** remains conservatively allocated. Combined estimate/allocation: **$0.49441585**, within $5. Includes assets, configuration diagnostics and final five cases. This is not a supplier invoice; missing usage is not zero and must not trigger repeat calls to obtain usage.

- Data revision: `c1d16b5ca07e65616376bb6d7261c21ddb510c5f33dd1195c34827cce79984d5`.
- Release bundle revision: `65acf8e91365836579c939585ea5a966a8cf6852ddfd48ac1712730f660243cd`.
- Card runtime revision: `18d396ee83fad164b479d99c282ae1c1a16e2e64770d905d8a0a13148f00a703`.
- Canonical revision: `f3b990889bef970312596a67f33f6e8302251af2a115d7d7dcf372f30b63c374`.
- Evaluated code SHA256: `f509441a2a2b0371b1ef14bea52b4dd2a5d703635514bb88dbddc428ef768160`; exact freeze in `freeze-bai-enabled.json`.
- Report root: `D:\Documents\游戏王项目产物\tcg-main-trial-20261010`; new reports `TCG-ruleset-五题结果.md`, `TCG-ruleset-五题逐题回答.md`.
- Authoritative private run: root `private/tcg-five-v1/`; final `results-bai-enabled.json`, `freeze-bai-enabled.json`, `call-metrics-bai-enabled.json`, `new-call-ledger.json`, `bai-enabled-cases/`.
- Actual prompts are private per-case `PROMPT_VISIBLE.private.txt`; do not publish them or the Oracle.
- Private references: root `private/tcg-evaluation-v1/references.private.json`; `cases` is an array keyed by `caseId`.
- Source HTTP cache: root `private/tcg-sync-cache`; prefer offline reserialization when unchanged.
- Assets: `data/tcg/{rule,qa}-embedding-v1` and `data/tcg/gemini-rule-qa-v1`. Reuse exact-request-compatible paid responses. Do not rerun old root `run-trial.mjs`, completed `prepare-five.mjs` or `run-five.mjs` without a new requirement.
- Backup: root `private/before-tcg-integration`. Twenty public questions in `evaluation/tcg/questions.json`; only these five evaluated here.

## Checkout and handoff

Dirty isolated tree with modified production files and new source/config/data/evaluation/test/docs files. No commit, push, PR, Preview or deployment. Preserve the tree and receipts. Git ownership argument: `git -c safe.directory='E:/codex-home/worktrees/tcg-source-trial/游戏王裁定问答' ...`. If later authorized to commit, use `coldiceh <53630656+coldiceh@users.noreply.github.com>` and no AI署名.

Sessions `17330`, `8050`, `1680`, `73110`, `54768`, offline legacy-check `91718`, paid-test `69230`, and round-two comparison `53297` are finished. No subagent, background test or paid API request remains running. Current chat ID from the app tool: `01a1277b-0e38-7152-b1e3-dae34065e4ef`; earlier raw-turn locations were not recovered. Next action: deliver round-two comparison report and stop at attachment step 3; await configuration/next instruction. No automatic additional repair, paid retry or full-flow test.

Final quota fix: invalidated same-query preload retains its used search/model allowance. Regression failed before fix and passed after. Candidate/preload/presentation checks 24/24. All four paid model replies and two source replies were exact-request/URL replayed on final backend hash d8cc0346fc93fb3b4481fe1235e667f4fc8923185647426618268d907d482c0f, with zero network/new model calls. Paid timings/cost remain those of frozen hash 6bc9f6413c8a202e935f645df000f51fa25243328bc9cfc55cfa3cd737fb343d; no new paid run. Final shared commit e741663820e8ea6f601d436a354eafd06de3f207. TCG also passed the 10 candidate routing and 2 target-body fixture checks after the quota fix.
