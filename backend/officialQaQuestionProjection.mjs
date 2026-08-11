/**
 * Build the identity-bearing projection of an official Q&A question.
 *
 * Rich snapshots keep structured question fields, while compact snapshots may
 * keep only `text` with a repeated, shortened title between the question and
 * answer.  Every matcher must derive question identities from this same
 * projection; answer/example card ids are deliberately excluded.
 */
export function projectOfficialQaQuestion(record = {}) {
  const title = String(record.title || "").trim();
  const text = String(record.text || "").trim();
  const explicitSurfaces = unique([
    record.rawDetailedQuestion,
    record.question,
    record.rawQuestion,
  ]);
  const leadingQuestion = extractLeadingQuestion(text, title);
  const answerText = extractAnswerText(record, text, title, leadingQuestion);
  const principalSurfaces = explicitSurfaces.length
    ? explicitSurfaces
    : unique([leadingQuestion]);
  const surfaces = unique([
    ...principalSurfaces,
    title,
  ]);
  const scenarioText = explicitSurfaces[0]
    || leadingQuestion
    || title;
  const principalText = principalSurfaces.join("\n") || title;
  const branches = splitOfficialQuestionBranches(scenarioText || principalText);

  return {
    questionText: scenarioText,
    scenarioText,
    principalText,
    principalSurfaces,
    surfaces,
    branches,
    answerText,
    principalCardIds: unique([
      ...(record.questionCardIds || []),
      ...extractInlineCardIds(principalText),
    ]),
  };
}

export function extractInlineOfficialCardIds(value) {
  return extractInlineCardIds(value);
}

function extractLeadingQuestion(text, title) {
  if (!text) return "";

  // Compact snapshots are commonly shaped as:
  //   complete question + repeated shortened title + complete answer.
  // The second title occurrence is therefore a stable answer boundary even
  // when the complete question contains several question marks.
  const repeatedTitleIndex = repeatedTitleBoundary(text, title);
  if (repeatedTitleIndex > 0) return text.slice(0, repeatedTitleIndex).trim();

  // Without a proven question/answer boundary, fail closed at the first
  // question mark. An answer or example may itself contain later questions.
  const firstAsciiMark = text.indexOf("?");
  const firstWideMark = text.indexOf("？");
  const firstQuestionMark = [firstAsciiMark, firstWideMark]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (firstQuestionMark >= 0) return text.slice(0, firstQuestionMark + 1).trim();
  return "";
}

function splitOfficialQuestionBranches(value) {
  const text = String(value || "").trim();
  if (!text) return [];

  const labelMatches = [...text.matchAll(/(?:^|\n+)\s*(\([A-ZＡ-Ｚ]\)|（[A-ZＡ-Ｚ]）)/gu)];
  if (labelMatches.length >= 2) {
    const starts = labelMatches.map((match) => (
      match.index + match[0].lastIndexOf(match[1])
    ));
    const sharedContext = text.slice(0, starts[0]).trim();
    return unique(starts.map((start, index) => {
      const branch = text.slice(start, starts[index + 1] ?? text.length).trim();
      return [sharedContext, branch].filter(Boolean).join("\n");
    }));
  }

  const questions = [...text.matchAll(/[^?？]*(?:[?？]|$)/gu)]
    .map((match) => match[0].trim())
    .filter((item) => item.length >= 4 && /[?？]$/u.test(item));
  return questions.length >= 2 ? unique(questions) : [text];
}

function extractAnswerText(record, text, title, leadingQuestion) {
  const structured = unique([record.answer, record.conclusion]).join("\n");
  if (structured) return structured;
  const repeatedTitleIndex = repeatedTitleBoundary(text, title);
  if (repeatedTitleIndex > 0) {
    return text.slice(repeatedTitleIndex + title.length).trim();
  }
  // No verified boundary: do not let an arbitrary legacy text tail contribute
  // mechanism semantics or answer-side identities.
  if (!leadingQuestion) return "";
  return "";
}

function repeatedTitleBoundary(text, title) {
  if (!text || title.length < 8) return -1;
  let offset = 1;
  while (offset < text.length) {
    const index = text.indexOf(title, offset);
    if (index < 0) return -1;
    const prefix = text.slice(0, index).trimEnd();
    const suffix = text.slice(index + title.length);
    // A compact snapshot repeats its shortened title after the complete
    // question. A natural occurrence inside the question is not a boundary.
    if (/[?？]$/u.test(prefix) && /^\s/u.test(suffix) && suffix.trim()) return index;
    offset = index + Math.max(1, title.length);
  }
  return -1;
}

function extractInlineCardIds(value) {
  return [...String(value || "").matchAll(/<<\s*(\d{1,10})\s*>>/gu)]
    .map((match) => match[1]);
}

function unique(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}
