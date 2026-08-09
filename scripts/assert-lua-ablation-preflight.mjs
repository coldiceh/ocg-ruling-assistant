#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFinalRulingInput } from "../backend/adminModelLabService.mjs";
import { projectLegacyLuaSemanticPacketForModel } from "../backend/legacyLuaSemanticPacket.mjs";
import { normalizeSnapshotBundle } from "./local-relay-effort-experiment.mjs";

export function parseLuaAblationPreflightArgs(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const field = ({
      "--bundle": "bundlePath",
      "--case": "caseId",
      "--cid": "cid",
      "--passcode": "passcode",
      "--atomic-operation": "atomicOperation",
      "--predicate-api": "predicateApi",
      "--selector-api": "selectorApi",
      "--required-minimum": "requiredMinimum",
    })[argument];
    if (!field) throw new TypeError(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
    index += 1;
    result[field] = value;
  }
  return result;
}

export function normalizeLuaAblationPreflightOptions(options = {}) {
  const requiredText = (field) => {
    const value = String(options[field] ?? "").trim();
    if (!value) throw new TypeError(`${field} is required`);
    return value;
  };
  const requiredMinimum = Number(options.requiredMinimum);
  if (!Number.isSafeInteger(requiredMinimum) || requiredMinimum < 0) {
    throw new TypeError("requiredMinimum must be a non-negative safe integer");
  }
  return Object.freeze({
    bundlePath: path.resolve(requiredText("bundlePath")),
    caseId: requiredText("caseId"),
    cid: requiredText("cid"),
    passcode: requiredText("passcode"),
    atomicOperation: requiredText("atomicOperation"),
    predicateApi: requiredText("predicateApi"),
    selectorApi: requiredText("selectorApi"),
    requiredMinimum,
  });
}

export function assertLuaAblationPreflight({
  bundle,
  caseId,
  cid,
  passcode,
  atomicOperation,
  predicateApi,
  selectorApi,
  requiredMinimum,
} = {}) {
  const cases = normalizeSnapshotBundle(bundle);
  const selected = cases.find((item) => item.caseId === caseId);
  if (!selected) throw new Error(`frozen source bundle is missing case ${caseId}`);

  const snapshot = selected.evidenceSnapshot;
  const resolvedCards = Array.isArray(snapshot?.evidence?.cardResolution?.resolvedCards)
    ? snapshot.evidence.cardResolution.resolvedCards
    : [];
  if (!resolvedCards.some((card) => String(card?.cid ?? card?.id ?? "") === cid)) {
    throw new Error(`${caseId} is not bound to resolved card CID ${cid}`);
  }

  const rawPacket = snapshot?.evidence?.legacyLuaSemanticPacket;
  if (!rawPacket) throw new Error(`${caseId} has no legacy Lua semantic packet`);
  const modelPacket = projectLegacyLuaSemanticPacketForModel(rawPacket);
  const sourceMarker = `cid-${cid}:passcode-${passcode}`;
  const matchingCandidates = (Array.isArray(modelPacket?.effectCandidates)
    ? modelPacket.effectCandidates
    : []).filter((candidate) => (
    String(candidate?.sourceBinding?.sourceDocumentId || "").includes(sourceMarker)
  ));
  if (matchingCandidates.length === 0) {
    throw new Error(`${caseId} Lua packet has no candidate bound to ${sourceMarker}`);
  }
  const matchingChecks = matchingCandidates.flatMap((candidate) => (
    Array.isArray(candidate?.activationLegalityChecks)
      ? candidate.activationLegalityChecks.map((check) => ({ candidate, check }))
      : []
  )).filter(({ check }) => (
    check?.atomicOperation === atomicOperation
    && check?.predicateApi === predicateApi
    && check?.requiredMinimum === requiredMinimum
    && check?.selectorSummary?.selectorApi === selectorApi
  ));
  if (matchingChecks.length === 0) {
    throw new Error(
      `${caseId} Lua packet lacks ${atomicOperation}/${predicateApi}/${selectorApi}/requiredMinimum=${requiredMinimum}`,
    );
  }

  const finalInput = buildFinalRulingInput(snapshot, {
    evidenceVariant: "card_text_plus_lua",
  });
  const payload = JSON.parse(finalInput.split("\n").at(-1));
  if (!payload.legacyLuaSemanticPacket) {
    throw new Error("card_text_plus_lua did not expose the verified Lua model packet");
  }
  const evidenceItems = payload?.evidenceDecisionPacket?.evidenceItems;
  if (!Array.isArray(evidenceItems) || evidenceItems.length === 0) {
    throw new Error("card_text_plus_lua has no visible card texts");
  }
  const nonCardText = evidenceItems.find((item) => item?.category !== "parsed_card_text");
  if (nonCardText) {
    throw new Error(`card_text_plus_lua leaked non-card-text evidence category ${nonCardText.category}`);
  }

  const [{ candidate, check }] = matchingChecks;
  return Object.freeze({
    ok: true,
    caseId,
    snapshotId: snapshot.snapshotId,
    cid,
    passcode,
    sourceDocumentId: candidate.sourceBinding.sourceDocumentId,
    atomicOperation: check.atomicOperation,
    predicateApi: check.predicateApi,
    requiredMinimum: check.requiredMinimum,
    selectorApi: check?.selectorSummary?.selectorApi || null,
    cardTextCount: evidenceItems.length,
  });
}

export async function runLuaAblationPreflightCli(
  argv = process.argv.slice(2),
  { readFileImpl = readFile, stdout = process.stdout } = {},
) {
  const parsed = parseLuaAblationPreflightArgs(argv);
  if (parsed.help) {
    stdout.write([
      "Usage: node scripts/assert-lua-ablation-preflight.mjs --bundle FILE --case ID --cid CID --passcode PASSCODE --atomic-operation OP --predicate-api API --selector-api API --required-minimum N",
      "",
    ].join("\n"));
    return null;
  }
  const options = normalizeLuaAblationPreflightOptions(parsed);
  const bundle = JSON.parse(await readFileImpl(options.bundlePath, "utf8"));
  const result = assertLuaAblationPreflight({ bundle, ...options });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runLuaAblationPreflightCli().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
