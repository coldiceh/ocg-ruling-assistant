const DEFAULT_MAX_BRANCHES = 4;
const DEFAULT_MAX_BRANCH_CHARS = 160;

export function splitRuleSearchQueryBranches(value, {
  maxBranches = DEFAULT_MAX_BRANCHES,
  maxBranchChars = DEFAULT_MAX_BRANCH_CHARS,
} = {}) {
  const safeBranchLimit = Math.max(1, Math.floor(Number(maxBranches) || DEFAULT_MAX_BRANCHES));
  const safeCharLimit = Math.max(1, Math.floor(Number(maxBranchChars) || DEFAULT_MAX_BRANCH_CHARS));
  return String(value || "")
    .normalize("NFKC")
    .split(/[|｜\r\n]+/u)
    .map((branch) => branch.replace(/\s+/gu, " ").trim().slice(0, safeCharLimit))
    .filter(Boolean)
    .slice(0, safeBranchLimit);
}

export function normalizeRuleSearchQueryText(value, options = {}) {
  return splitRuleSearchQueryBranches(value, options).join(" | ");
}

export function selectOfficialQaSearchBranch(value, options = {}) {
  const branches = splitRuleSearchQueryBranches(value, options);
  if (!branches.length) return "";

  // The synchronized official database is primarily Japanese. Prefer the
  // planner's Japanese question when it supplied one; otherwise keep a
  // deterministic complete branch instead of mixing several languages into
  // one similarity query.
  const japanese = branches
    .map((branch) => {
      const kana = countJapaneseKana(branch);
      return {
        branch,
        kana,
        japaneseRatio: kana / Math.max(1, [...branch].length),
      };
    })
    .filter(({ kana }) => kana > 0)
    .sort((left, right) => (
      right.kana - left.kana
        || right.japaneseRatio - left.japaneseRatio
        || right.branch.length - left.branch.length
        || left.branch.localeCompare(right.branch)
    ))[0];
  if (japanese) return japanese.branch;
  return [...branches].sort((left, right) => (
    countCjk(right) - countCjk(left)
      || right.length - left.length
      || left.localeCompare(right)
  ))[0];
}

function countCjk(value) {
  return [...String(value || "").matchAll(/[\u3400-\u9fff]/gu)].length;
}

function countJapaneseKana(value) {
  return [...String(value || "").matchAll(/[\u3040-\u30ff]/gu)].length;
}
