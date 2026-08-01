import { createHash } from "node:crypto";

const VERSION = "ocg-executable-scenario/v1";
const FILLER = 40640057;
const MONSTER_ZONE = 4;
const SPELL_TRAP_ZONE = 8;

export function autoEngineSimulationEnabled(env = {}) {
  const enabled = /^(?:1|true|on|enabled|yes)$/iu.test(
    String(env.RAG_AUTO_ENGINE_SIMULATION ?? "false").trim(),
  );
  return enabled && Boolean(String(env.OCG_ENGINE_URL || "").trim());
}

export function buildBestEffortEngineScenario({ userQuery, cards = [] } = {}) {
  const query = String(userQuery || "").trim();
  const planned = dedupe((cards || []).map((card) => planCard(card, query)).filter(Boolean));
  const warnings = ["engine_scenario_best_effort_not_official"];
  if (!planned.length) warnings.push("engine_scenario_has_no_resolved_passcodes");
  const setupCards = fillerDecks();
  const sequences = new Map();
  for (const card of planned) {
    const key = card.team + ":" + card.location;
    const seq = sequences.get(key) || 0;
    sequences.set(key, seq + 1);
    card.sequence = seq;
    setupCards.push({
      team: card.team,
      duelist: 0,
      code: card.code,
      con: card.team,
      loc: card.location,
      seq,
      pos: card.position,
    });
  }
  const responses = responsePlan(query, planned);
  if (!responses.length) warnings.push("engine_scenario_setup_only");
  return {
    source: "auto_best_effort",
    bestEffort: true,
    warnings,
    planSummary: {
      cardCount: planned.length,
      responseCount: responses.length,
      cards: planned.map(({ name, code, team, location, position }) => ({
        name,
        code,
        team,
        location,
        position,
      })),
    },
    scenario: {
      schemaVersion: VERSION,
      seed: "rag-" + createHash("sha256").update(query || "empty-query").digest("hex").slice(0, 24),
      bestEffort: true,
      setup: { cards: setupCards },
      options: {
        flags: "2e800",
        team1: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 1 },
        team2: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 1 },
      },
      responses,
    },
  };
}

function planCard(card, query) {
  const code = engineCode(card);
  if (!code) return null;
  const mention = findMention(card, query);
  const context = localContext(query, mention);
  const team = inferTeam(context.before, context.full);
  const location = inferLocation(context.before, context.full, card);
  return {
    card,
    code,
    name: card.name || card.cnName || mention.text || String(code),
    team,
    location,
    position: inferPosition(context.full, location),
  };
}

function engineCode(card = {}) {
  for (const value of [
    card.passcode,
    card.password,
    card.raw?.id,
    card.raw?.password,
    card.raw?.passcode,
    card.raw?.raw?.id,
  ]) {
    const text = String(value ?? "").trim();
    if (/^\d{8}$/u.test(text) && Number(text) > 0) return Number(text);
  }
  return null;
}

function names(card = {}) {
  return [
    card.input,
    card.matchedQuery,
    card.name,
    card.cnName,
    card.jaName,
    card.jpName,
    card.enName,
    ...(card.aliases || []),
  ].map((item) => String(item || "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function findMention(card, query) {
  let result = { index: -1, text: names(card)[0] || "" };
  for (const name of names(card)) {
    const index = query.indexOf(name);
    if (index >= 0 && (result.index < 0 || index < result.index)) result = { index, text: name };
  }
  return result;
}

function localContext(query, mention) {
  if (!query || mention.index < 0) return { before: query, full: query };
  const delimiter = /[。！？!?\n]/u;
  let start = mention.index;
  while (start > 0 && !delimiter.test(query[start - 1])) start -= 1;
  let end = mention.index + mention.text.length;
  while (end < query.length && !delimiter.test(query[end])) end += 1;
  const full = query.slice(start, end);
  return { before: full.slice(0, mention.index - start), full };
}

function inferTeam(before, full) {
  const role = [...String(before || "").matchAll(/我方|自己|我|对方|對方|对手|對手/gu)].at(-1)?.[0] || "";
  if (/对方|對方|对手|對手/u.test(role)) return 1;
  if (/我方|自己|我/u.test(role)) return 0;
  return /对方|對方|对手|對手/u.test(full) && !/我方|自己/u.test(full) ? 1 : 0;
}

function inferLocation(before, full, card) {
  const candidates = [
    ["extra_deck", /额外卡组|額外牌組|EX卡组|EX牌組/gu],
    ["hand", /手牌|手卡|手札/gu],
    ["graveyard", /墓地/gu],
    ["banished", /除外/gu],
    ["spell_trap_zone", /魔法(?:与|和|・)?陷阱区|魔陷区|魔法陷阱区/gu],
    ["field", /场上|場上|怪兽区|怪獸區/gu],
  ];
  let selected = null;
  for (const [location, pattern] of candidates) {
    const index = [...String(before || "").matchAll(pattern)].at(-1)?.index ?? -1;
    if (index >= 0 && (!selected || index > selected.index)) selected = { location, index };
  }
  if (!selected) {
    for (const [location, pattern] of candidates) {
      pattern.lastIndex = 0;
      if (pattern.test(full)) {
        selected = { location, index: 0 };
        break;
      }
    }
  }
  if (selected?.location === "field") return isSpellTrap(card) ? "spell_trap_zone" : "monster_zone";
  return selected?.location || "hand";
}

function inferPosition(context, location) {
  if (location === "monster_zone") {
    if (/里侧|裏側|盖放|蓋放/u.test(context)) return "facedown_defense";
    if (/守备|守備/u.test(context)) return "faceup_defense";
    return "faceup_attack";
  }
  if (location === "spell_trap_zone" && /表侧|表側/u.test(context)) return "faceup_attack";
  return "facedown_defense";
}

function isSpellTrap(card = {}) {
  return /spell|trap|魔法|陷阱|罠/iu.test([
    card.cardType,
    card.type,
    card.raw?.text?.types,
  ].filter(Boolean).join(" "));
}

function dedupe(cards) {
  const result = [];
  const seen = new Set();
  for (const card of cards) {
    const key = card.team + ":" + card.code;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(card);
    }
  }
  return result;
}

function fillerDecks() {
  const cards = [];
  for (let team = 0; team < 2; team += 1) {
    for (let index = 0; index < 40; index += 1) {
      cards.push({
        team,
        duelist: 0,
        code: FILLER,
        con: team,
        loc: "deck",
        seq: 0,
        pos: "facedown_defense",
      });
    }
  }
  return cards;
}

function responsePlan(query, cards) {
  const result = [];
  const summoned = actionCard(
    query,
    cards.filter((card) => card.team === 0 && card.location === "hand"),
    /召唤|召喚/u,
  );
  if (summoned) {
    result.push({ encoding: "idle_command", action: "summon", cardCode: summoned.code });
    result.push({
      encoding: "place",
      selections: [{ player: 0, location: MONSTER_ZONE, sequence: freeSequence(cards, 0, "monster_zone") }],
    });
    if (/发动.{0,12}(?:效果|①|②|③)|效果.{0,8}发动/u.test(query)) {
      result.push({ encoding: "chain", action: "activate", cardCode: summoned.code });
      const discarded = actionCard(
        query,
        cards.filter((card) => card.team === 0 && card.location === "hand" && card.code !== summoned.code),
        /舍弃|丢弃|棄/u,
      );
      if (discarded) result.push({ encoding: "card_selection", cardCodes: [discarded.code] });
      appendFusion(result, query, cards, summoned);
    }
    return result;
  }

  const activated = actionCard(query, cards.filter((card) => card.team === 0), /发动|發動/u);
  if (!activated) return result;
  result.push({ encoding: "idle_command", action: "activate", cardCode: activated.code });
  if (activated.location === "hand" && isSpellTrap(activated.card)) {
    result.push({
      encoding: "place",
      selections: [{ player: 0, location: SPELL_TRAP_ZONE, sequence: freeSequence(cards, 0, "spell_trap_zone") }],
    });
  }
  const target = targetCard(query, cards.filter((card) => card.code !== activated.code));
  if (target) result.push({ encoding: "card_selection", cardCodes: [target.code] });
  const chained = actionCard(
    query,
    cards.filter((card) => card.team === 1 && card.code !== target?.code),
    /发动|發動/u,
  );
  if (chained) result.push({ encoding: "chain", action: "activate", cardCode: chained.code });
  return result;
}

function appendFusion(result, query, cards, summoned) {
  if (!/融合召唤|融合召喚/u.test(query)) return;
  const opponent = cards.find((card) => card.team === 1 && card.location === "monster_zone");
  if (opponent) {
    result.push({ encoding: "card_selection", cardCodes: [summoned.code, opponent.code] });
  }
  const fusion = cards.find((card) => card.team === 0 && card.location === "extra_deck");
  if (!fusion) return;
  result.push({ encoding: "card_selection", cardCodes: [fusion.code] });
  result.push({
    encoding: "place",
    selections: [{ player: 0, location: MONSTER_ZONE, sequence: freeSequence(cards, 0, "monster_zone") }],
  });
  result.push({ encoding: "position", value: "faceup_attack" });
}

function actionCard(query, cards, verb) {
  let direct = null;
  let trailing = null;
  for (const card of cards) {
    for (const name of names(card.card)) {
      const escaped = escapeRegExp(name);
      const directMatch = query.match(new RegExp("(?:" + verb.source + ").{0,12}" + escaped, "iu"));
      if (directMatch && (!direct || directMatch.index < direct.index || (directMatch.index === direct.index && directMatch[0].length < direct.length))) {
        direct = { card, index: directMatch.index, length: directMatch[0].length };
      }
      const trailingMatch = query.match(new RegExp(escaped + ".{0,12}(?:" + verb.source + ")", "iu"));
      if (trailingMatch && (!trailing || trailingMatch.index < trailing.index || (trailingMatch.index === trailing.index && trailingMatch[0].length < trailing.length))) {
        trailing = { card, index: trailingMatch.index, length: trailingMatch[0].length };
      }
    }
  }
  return direct?.card || trailing?.card || null;
}

function targetCard(query, cards) {
  for (const card of cards) {
    for (const name of names(card.card)) {
      const pattern = new RegExp(
        "(?:以|把|将|將).{0,6}" + escapeRegExp(name) + ".{0,8}(?:为|為|作)(?:效果)?对象",
        "iu",
      );
      if (pattern.test(query)) return card;
    }
  }
  return null;
}

function freeSequence(cards, team, location) {
  const used = new Set(
    cards.filter((card) => card.team === team && card.location === location)
      .map((card) => card.sequence),
  );
  for (let sequence = 0; sequence < 5; sequence += 1) {
    if (!used.has(sequence)) return sequence;
  }
  return 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
