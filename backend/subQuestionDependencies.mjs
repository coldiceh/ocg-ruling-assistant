const REFERENCED_MONSTER_ENTITY = "referenced_monster";

export function buildSubQuestionDependencyGraph(formalQuery, eventTimeline = {}) {
  const questions = Array.isArray(formalQuery?.subQuestions) ? formalQuery.subQuestions : [];
  const nodes = questions.map((item) => ({
    questionId: String(item.id || "unknown"),
    type: String(item.type || "unknown"),
    card: String(item.card || "unknown"),
    sourceText: String(item.sourceText || "unknown"),
  }));
  const edges = [];
  const warnings = [];

  for (let leftIndex = 0; leftIndex < questions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < questions.length; rightIndex += 1) {
      const left = questions[leftIndex];
      const right = questions[rightIndex];
      const leftEntity = referencedEntity(left);
      const rightEntity = referencedEntity(right);

      if (isTemporaryBanishQuestion(left) && isSendToGraveyardQuestion(right) && entitiesOverlap(leftEntity, rightEntity)) {
        addEdge(edges, {
          fromQuestionId: left.id,
          toQuestionId: right.id,
          relation: "depends_on_verdict",
          reason: `${right.id} 的送墓结果取决于 ${left.id} 的暂时除外能否成立`,
        });
      } else if (isTemporaryBanishQuestion(right) && isSendToGraveyardQuestion(left) && entitiesOverlap(rightEntity, leftEntity)) {
        addEdge(edges, {
          fromQuestionId: right.id,
          toQuestionId: left.id,
          relation: "depends_on_verdict",
          reason: `${left.id} 的送墓结果取决于 ${right.id} 的暂时除外能否成立`,
        });
      }

      const activation = left.type === "activation_location" ? left : right.type === "activation_location" ? right : null;
      const location = left.type === "location_change" ? left : right.type === "location_change" ? right : null;
      if (activation && location && entitiesOverlap(referencedEntity(activation), referencedEntity(location))) {
        addEdge(edges, {
          fromQuestionId: location.id,
          toQuestionId: activation.id,
          relation: "depends_on_zone",
          reason: `${activation.id} 的发动位置取决于 ${location.id} 所确认的区域状态`,
        });
        addEdge(edges, {
          fromQuestionId: activation.id,
          toQuestionId: location.id,
          relation: "same_event_chain",
          reason: `${activation.id} 与 ${location.id} 引用同一卡片在同一战斗破坏事件中的状态`,
        });
      } else if (sameScenarioReference(left, right, eventTimeline)) {
        addEdge(edges, {
          fromQuestionId: left.id,
          toQuestionId: right.id,
          relation: "same_event_chain",
          reason: `${left.id} 与 ${right.id} 引用同一场景实体或时点`,
        });
      }
    }
  }

  for (const [index, question] of questions.entries()) {
    const text = String(question.sourceText || "");
    const prior = questions.slice(0, index);
    const monsterReference = referencedMonsterSurface(text);
    if (monsterReference && isAnaphoricMonsterReference(monsterReference) && !canResolveMonsterReference(question, prior)) {
      warnings.push(`${question.id}:unresolved_reference:${monsterReference}`);
    }
    if (/这个时候/u.test(text) && !canResolveTimingReference(question, prior, eventTimeline)) {
      warnings.push(`${question.id}:unresolved_reference:这个时候`);
    }
    if (/这个效果/u.test(text) && !canResolveEffectReference(question, prior)) {
      warnings.push(`${question.id}:unresolved_reference:这个效果`);
    }
  }

  return { nodes, edges, warnings: [...new Set(warnings)] };
}

function isTemporaryBanishQuestion(question) {
  return question?.type === "temporary_banish"
    || /(?:能否|能用|可以|是否).{0,30}除外/u.test(String(question?.sourceText || ""));
}

function isSendToGraveyardQuestion(question) {
  return question?.type === "send_to_gy"
    || /(?:还会|会不会|是否).{0,24}(?:送墓|送去墓地)/u.test(String(question?.sourceText || ""));
}

function referencedEntity(question) {
  const text = String(question?.sourceText || "");
  if (question?.card === REFERENCED_MONSTER_ENTITY || referencedMonsterSurface(text)) return REFERENCED_MONSTER_ENTITY;
  const card = normalize(question?.card);
  return card && card !== "unknown" ? card : "unknown";
}

function entitiesOverlap(left, right) {
  if (!left || !right || left === "unknown" || right === "unknown") return false;
  return left === right || left.includes(right) || right.includes(left);
}

function sameScenarioReference(left, right, eventTimeline) {
  const leftEntity = referencedEntity(left);
  const rightEntity = referencedEntity(right);
  const sameEntity = entitiesOverlap(leftEntity, rightEntity);
  if (sameEntity) return true;
  const leftText = String(left?.sourceText || "");
  const rightText = String(right?.sourceText || "");
  const combinedText = `${leftText} ${rightText}`;
  const hasAnaphora = /(?:这个时候|这个效果)/u.test(combinedText)
    || isAnaphoricMonsterReference(referencedMonsterSurface(combinedText));
  const hasUnknownEntity = leftEntity === "unknown" || rightEntity === "unknown";
  return hasUnknownEntity && hasAnaphora && eventTimeline?.timing?.currentWindow && eventTimeline.timing.currentWindow !== "unknown";
}

function canResolveMonsterReference(question, prior) {
  const entity = referencedEntity(question);
  if (entity !== "unknown" && entity !== REFERENCED_MONSTER_ENTITY) return true;
  if (entity === REFERENCED_MONSTER_ENTITY && !isAnaphoricMonsterReference(referencedMonsterSurface(question?.sourceText))) return true;
  return prior.some((item) => referencedEntity(item) !== "unknown");
}

function referencedMonsterSurface(value) {
  const text = String(value || "");
  const match = text.match(/(?:该|这|那|上述|前述)(?:只)?(?:[\p{L}\p{N}·・=－—-]{0,12})?怪兽|(?:^|[，。；！？：:\s])((?:[\p{L}\p{N}·・=－—-]{0,12})怪兽)(?=.{0,18}(?:还会|会不会|是否|能否|可以|可否|能用|送墓|除外|发动|处理))|(?:その|この|あの)(?:[^、。！？\s]{0,12})?モンスター|(?:that|this|the\s+referenced)(?:\s+[\p{L}\p{N}-]+){0,4}\s+monster/iu);
  return String(match?.[1] || match?.[0] || "").trim();
}

function isAnaphoricMonsterReference(value) {
  return /^(?:(?:该|这|那|上述|前述)(?:只)?|(?:その|この|あの)|(?:that|this|the\s+referenced)\b)/iu.test(String(value || "").trim());
}

function canResolveTimingReference(question, prior, eventTimeline) {
  if (question?.card && question.card !== "unknown" && prior.length) return true;
  return Boolean(eventTimeline?.timing?.currentWindow && eventTimeline.timing.currentWindow !== "unknown");
}

function canResolveEffectReference(question, prior) {
  if (question?.card && question.card !== "unknown") return true;
  return prior.some((item) => item.card && item.card !== "unknown" && /效果/u.test(String(item.sourceText || "")));
}

function addEdge(edges, edge) {
  const key = `${edge.fromQuestionId}|${edge.toQuestionId}|${edge.relation}`;
  if (!edges.some((item) => `${item.fromQuestionId}|${item.toQuestionId}|${item.relation}` === key)) edges.push(edge);
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
