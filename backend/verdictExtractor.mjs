export function normalizeEvidenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u00a0\s]+/gu, " ")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .trim();
}

export function detectPolarity(value) {
  const text = normalizeEvidenceText(value);
  const negative = /(?:不可以|不能|无法|不可|不(?:能|会)|できません|できない|ではありません|ない|cannot|can't|can not|may not|no\b|not\b)/iu.test(text);
  const positive = /(?:可以|能够|能(?:够)?|できます|できる|可能です|\bcan\b|\byes\b|may\b)/iu.test(text);
  if (negative) return "negative";
  if (positive) return "positive";
  return "unknown";
}

export function detectLocationVerdict(value) {
  const text = normalizeEvidenceText(value);
  const locations = [];
  if (/(?:在|从)墓地(?:中)?(?:发动|發動)|墓地で.{0,16}発動|(?:can be |is )?activated.{0,16}(?:in|from) (?:the )?(?:graveyard|gy)|activate.{0,16}(?:in|from) (?:the )?(?:graveyard|gy)/iu.test(text)) {
    locations.push("activates_in_graveyard");
  }
  if (/(?:在)?(?:怪兽区域|怪兽区|场上)(?:中)?(?:发动|發動)|モンスターゾーンで.{0,16}発動|(?:can be |is )?activated.{0,16}(?:in|from) (?:the )?(?:monster zone|field)|activate.{0,16}(?:in|from|on) (?:the )?(?:monster zone|field)/iu.test(text)) {
    locations.push("activates_on_field");
  }
  if (/(?:在)?除外状态(?:中)?(?:发动|發動)|除外されている状態で.{0,16}発動|除外状態で.{0,16}発動|(?:can be |is )?activated.{0,16}(?:while |when )?banished|activate.{0,16}(?:while |when )?banished/iu.test(text)) {
    locations.push("activates_while_banished");
  }
  return [...new Set(locations)];
}

export function detectConditionalBranches(value) {
  const text = normalizeEvidenceText(value);
  const conditionMarkers = text.match(/(?:如果|若|当.{0,8}时|场合|場合|とき|時|\bif\b|\bwhen\b)/giu) || [];
  const locations = detectLocationVerdict(text);
  return {
    conditional: conditionMarkers.length > 0 && locations.length > 1,
    conditionCount: conditionMarkers.length,
    locations,
  };
}

export function detectActionVerdict(subQuestion, value) {
  const text = normalizeEvidenceText(value);
  const type = subQuestion?.type || "unknown";
  const conditional = detectConditionalBranches(text);
  if (conditional.conditional) {
    return unknown("conditional_branch_not_selected", ["conditional_evidence_requires_branch_selection"], { conditional });
  }
  if (/^(?:不可以|不能|否|不是|no)[。.!！]?$/iu.test(text)) return result("no", "explicit_no");
  if (/^(?:可以|是|会|yes)[。.!！]?$/iu.test(text)) return result("yes", "explicit_yes");

  if (type === "activation_location") {
    const locations = conditional.locations;
    if (locations.length === 1 && !isLocationNegated(text, locations[0])) {
      return result(locations[0], `explicit_location:${locations[0]}`, [], { locations });
    }
    if (locations.length > 1) return unknown("conditional_branch_not_selected", ["multiple_activation_locations"], { locations });
    return unknown(actionMentioned(type, text) ? "no_explicit_location" : "evidence_mentions_action_but_not_asked_result");
  }

  if (type === "temporary_banish") {
    const negative = /(?:不可以|不能|无法|不可).{0,20}(?:除外|适用(?:这个|该|此)?效果)|(?:除外|この効果).{0,20}(?:できません|できない|適用できません)|(?:cannot|can't|can not).{0,20}(?:banish|apply (?:this|the) effect)/iu.test(text);
    const positive = /(?:可以|能够|能).{0,20}(?:除外|适用(?:这个|该|此)?效果)|(?:除外できます|除外することができます|この効果を適用できます|この効果を適用できる)|(?:\bcan\b|may).{0,20}(?:banish|apply (?:this|the) effect)/iu.test(text);
    if (negative) return result("cannot", "explicit_cannot_banish");
    if (positive) return result("can", "explicit_can_banish");
    return unknownForAction(type, text);
  }

  if (type === "activation_condition" || type === "timing") {
    const negative = /(?:不可以|不能|无法|不可).{0,16}(?:发动|發動)|(?:発動|この効果).{0,16}(?:できません|できない)|(?:cannot|can't|can not).{0,16}(?:activate|be activated)/iu.test(text);
    const positive = /(?:可以|能够|能).{0,16}(?:发动|發動)|(?:発動できます|発動できる)|(?:\bcan\b|may).{0,16}(?:activate|be activated)/iu.test(text);
    if (negative) return result("cannot", "explicit_cannot_activate");
    if (positive) return result("can", "explicit_can_activate");
    return unknownForAction(type, text);
  }

  if (type === "send_to_gy" || type === "location_change") {
    const negative = /(?:不送去墓地|不会.{0,12}送墓|不能.{0,12}送墓|不被送去墓地)|墓地へ.{0,12}送られません|墓地へ送られない|(?:is|are|will be) not sent to (?:the )?(?:graveyard|gy)|not sent to (?:the )?(?:graveyard|gy)/iu.test(text);
    const positive = /(?:送去墓地|送入墓地|被送墓)|墓地へ.{0,12}送られます|墓地へ送られる|(?:is|are|will be|was|were) sent to (?:the )?(?:graveyard|gy)|sent to (?:the )?(?:graveyard|gy)/iu.test(text);
    if (negative) return result("not_sent_to_graveyard", "explicit_not_sent_to_graveyard");
    if (positive) return result("sent_to_graveyard", "explicit_sent_to_graveyard");
    return unknownForAction(type, text);
  }

  if (type === "return_to_deck") {
    const negative = /(?:不|不会|不能).{0,12}(?:回到|返回).{0,8}卡组|デッキに戻りません|(?:does|will) not return to (?:the )?deck/iu.test(text);
    const positive = /(?:回到|返回).{0,8}卡组|デッキに戻ります|デッキに戻る|returns? to (?:the )?deck/iu.test(text);
    if (negative) return result("no", "explicit_not_return_to_deck");
    if (positive) return result("returns_to_original_zone", "explicit_return_to_deck");
    return unknownForAction(type, text);
  }

  if (type === "resolution_handling") {
    const polarity = detectPolarity(text);
    if (polarity === "negative") return result("no", "explicit_negative_resolution");
    if (polarity === "positive") return result("yes", "explicit_positive_resolution");
    if (polarity === "conflict") return unknown("conflicting_polarity_in_evidence", ["polarity_conflict"]);
  }

  return unknownForAction(type, text);
}

function unknownForAction(type, text) {
  if (!actionMentioned(type, text)) return unknown("evidence_mentions_action_but_not_asked_result");
  return detectPolarity(text) === "unknown"
    ? unknown("no_explicit_polarity")
    : unknown("evidence_mentions_action_but_not_asked_result");
}

function isLocationNegated(text, verdict) {
  const location = verdict === "activates_in_graveyard"
    ? "(?:墓地|graveyard|gy)"
    : verdict === "activates_on_field"
      ? "(?:怪兽区域|怪兽区|场上|モンスターゾーン|monster zone|field)"
      : "(?:除外状态|除外されている状態|banished)";
  return new RegExp(`(?:不能|无法|できません|できない|cannot|can't|not).{0,24}${location}.{0,16}(?:发动|発動|activate)|${location}.{0,16}(?:不能|できません|cannot|not).{0,16}(?:发动|発動|activate)`, "iu").test(text);
}

function actionMentioned(type, text) {
  if (type === "temporary_banish") return /除外|banish/iu.test(text);
  if (type === "activation_condition" || type === "activation_location" || type === "timing") return /发动|發動|発動|activat/iu.test(text);
  if (type === "send_to_gy" || type === "location_change") return /送墓|送去墓地|送入墓地|墓地へ送|sent to (?:the )?(?:graveyard|gy)/iu.test(text);
  if (type === "return_to_deck") return /回到卡组|返回卡组|デッキに戻|return to (?:the )?deck/iu.test(text);
  return false;
}

function result(verdict, reason, warnings = [], details = {}) {
  return { verdict, reason, whyUnknown: null, warnings, ...details };
}

function unknown(whyUnknown, warnings = [], details = {}) {
  return { verdict: "unknown", reason: whyUnknown, whyUnknown, warnings, ...details };
}
