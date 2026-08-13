#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFinalRulingInput } from "../backend/adminModelLabService.mjs";
import { buildLegacyLuaPromptModule } from "../backend/legacyLuaPromptModule.mjs";
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
  const expectedCid = normalizePositiveDecimal(cid, null);
  const expectedPasscode = normalizePositiveDecimal(passcode, 0xffff_ffffn);
  if (!expectedCid || !expectedPasscode) {
    throw new Error(`${caseId} requires a valid positive CID and passcode`);
  }
  const matchingResolvedCards = resolvedCards
    .map(resolvedCardIdentity)
    .filter((identity) => identity?.cid === expectedCid);
  if (
    matchingResolvedCards.length !== 1
    || matchingResolvedCards[0].passcode !== expectedPasscode
  ) {
    throw new Error(
      `${caseId} is not uniquely bound to resolved card CID ${expectedCid} and passcode ${expectedPasscode}`,
    );
  }

  const rawPacket = snapshot?.evidence?.legacyLuaSemanticPacket || null;
  const moduleResult = buildLegacyLuaPromptModule({
    packet: rawPacket,
    resolvedCards,
    enabled: true,
  });
  if (moduleResult.status !== "READY") {
    throw new Error(
      `${caseId} Lua prompt module is not READY (${moduleResult.audit.reasonCategory})`,
    );
  }
  const matchingCards = (Array.isArray(moduleResult.modelPayload?.cards)
    ? moduleResult.modelPayload.cards
    : []).filter((card) => String(card?.cardRef?.cid || "") === expectedCid);
  if (matchingCards.length !== 1) {
    throw new Error(`${caseId} Lua prompt has no unique card binding for CID ${expectedCid}`);
  }
  const matchingChecks = (Array.isArray(matchingCards[0]?.effects)
    ? matchingCards[0].effects
    : []).flatMap((effect) => (
    Array.isArray(effect?.activationChecks)
      ? effect.activationChecks.map((check) => ({ effect, check }))
      : []
  )).filter(({ check }) => (
    check?.atomicOperation === atomicOperation
    && check?.predicateApi === predicateApi
    && check?.minimumCount === requiredMinimum
    && check?.selector?.selectorApi === selectorApi
  ));
  if (matchingChecks.length === 0) {
    throw new Error(
      `${caseId} Lua prompt lacks ${atomicOperation}/${predicateApi}/${selectorApi}/minimumCount=${requiredMinimum}`,
    );
  }

  const baselineInput = buildFinalRulingInput(snapshot, {
    evidenceVariant: "card_text_only",
  });
  const finalInput = buildFinalRulingInput(snapshot, {
    evidenceVariant: "card_text_plus_lua",
  });
  if (finalInput !== `${baselineInput}\n${moduleResult.promptAddon}`) {
    throw new Error("card_text_plus_lua changed more than the isolated Lua prompt addon");
  }
  if (countOccurrences(finalInput, "legacyLuaPromptHints:") !== 1) {
    throw new Error("card_text_plus_lua must append exactly one Lua prompt addon");
  }
  if (/legacyLuaSemanticPacket/u.test(finalInput)) {
    throw new Error("card_text_plus_lua leaked the legacy semantic packet envelope");
  }
  const baselinePayload = JSON.parse(baselineInput.split("\n").at(-1));
  const payload = JSON.parse(finalInput.split("\n").find((line) => (
    line.startsWith("{\"schemaVersion\":2,\"evidenceSnapshot\"")
  )));
  if (JSON.stringify(payload) !== JSON.stringify(baselinePayload)) {
    throw new Error("Lua and baseline variants do not share the same frozen evidence payload");
  }
  const evidenceItems = payload?.evidenceDecisionPacket?.evidenceItems;
  if (!Array.isArray(evidenceItems) || evidenceItems.length === 0) {
    throw new Error("card_text_plus_lua has no visible card texts");
  }
  const nonCardText = evidenceItems.find((item) => item?.category !== "parsed_card_text");
  if (nonCardText) {
    throw new Error(`card_text_plus_lua leaked non-card-text evidence category ${nonCardText.category}`);
  }

  const [{ check }] = matchingChecks;
  return Object.freeze({
    ok: true,
    caseId,
    snapshotId: snapshot.snapshotId,
    cid: expectedCid,
    passcode: expectedPasscode,
    luaPromptModuleVersion: moduleResult.audit.moduleVersion,
    luaPromptPayloadSha256: moduleResult.audit.payloadSha256,
    atomicOperation: check.atomicOperation,
    predicateApi: check.predicateApi,
    requiredMinimum: check.minimumCount,
    selectorApi: check?.selector?.selectorApi || null,
    cardTextCount: evidenceItems.length,
  });
}

function countOccurrences(value, needle) {
  return String(value).split(needle).length - 1;
}

function resolvedCardIdentity(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const sourceCid = String(card.sourceUrl || card.ygoResourcesUrl || "")
    .match(/\/data\/card\/([1-9]\d{0,9})(?:$|[/?#])/u)?.[1];
  const cids = uniquePositiveDecimals([
    card.cid,
    sourceCid,
    card.id,
    card.cardId,
    card.raw?.cid,
  ], null);
  const passcodes = uniquePositiveDecimals([
    card.passcode,
    card.password,
    card.raw?.passcode,
    card.raw?.password,
  ], 0xffff_ffffn);
  if (cids.length !== 1 || passcodes.length !== 1) return null;
  return { cid: cids[0], passcode: passcodes[0] };
}

function uniquePositiveDecimals(values, maximum) {
  return [...new Set(values
    .map((value) => normalizePositiveDecimal(value, maximum))
    .filter(Boolean))];
}

function normalizePositiveDecimal(value, maximum) {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d+$/u.test(text)) return null;
  const numeric = BigInt(text);
  if (numeric <= 0n || (maximum !== null && numeric > maximum)) return null;
  return numeric.toString(10);
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
