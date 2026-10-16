// Planner prompt for the experimental engine-reproduction section.
// The planner translates one question into an engine scenario + replay actions. It never
// answers the ruling. Everything static lives in PLANNER_INSTRUCTIONS so that its hash is the
// prompt version used for caching and for the result log.
import { createHash } from "node:crypto";

export const FILLER_CARDS = Object.freeze([
  { code: 13179332, name: "大木炭18", note: "通常怪兽 1星 炎/炎 100/2100" },
  { code: 756652, name: "多隆", note: "通常怪兽 2星 地/战士 900/500" },
  { code: 1761063, name: "猫妖精", note: "通常怪兽 3星 地/兽 1100/900" },
  { code: 1184620, name: "魔物狩人", note: "通常怪兽 4星 地/战士 1500/1200" },
  { code: 549481, name: "硬毛鼠", note: "通常怪兽 4星 地/兽 500/2000" },
  { code: 2971090, name: "战神 奥利安", note: "通常怪兽 5星 光/天使 1800/1500" },
  { code: 13069066, name: "剑龙", note: "通常怪兽 6星 地/恐龙 1750/2030" },
  { code: 46986414, name: "黑魔术师", note: "通常怪兽 7星 暗/魔法师 2500/2100" },
  { code: 89631139, name: "青眼白龙", note: "通常怪兽 8星 光/龙 3000/2500" },
]);

// Generic tool cards shared by every question (fixed list; engine text is attached at run time).
export const TOOL_CARD_CODES = Object.freeze([83764718, 81439173, 5318639, 8267140, 53129443, 12580477, 94192409,
  14087893, 41420027, 4206964, 72892473]);

const REASON_CODES = ["pure_rule", "archetype_level", "tournament_policy", "ruleset_version"];

export const PLANNER_INSTRUCTIONS = [
  "你是游戏王 OCG 裁定题的“引擎复现计划器”。你的任务：把题目翻译成 ygopro 引擎（MyCard 核心，大师规则2020）能执行的局面和操作，让引擎跑一遍、展示发生了什么。你不回答裁定、不写结论、不推测引擎结果。",
  "",
  "## 输出",
  "只输出一个 JSON 对象，不要 markdown、不要解释。结构如下（null 指 JSON 的 null，不要写成字符串 \"null\"）：",
  JSON.stringify({
    applicability: "applicable", reason_code: null, archetype_name: null, quoted_span: "…", what_not_why: false,
    assumptions: [], extra_cards: [],
    sub_questions: [{ id: "q1", quoted_span: "…", unrepresentable: null,
      branches: [{ id: "b1", assumption: null, scenario: {}, actions: {}, observe: "…" }] }],
  }),
  "字段说明：",
  "- applicability：\"applicable\" 或 \"not_applicable\"。",
  "- reason_code：not_applicable 时填 " + REASON_CODES.join(" / ") + "；applicable 时为 null。archetype_name：仅 archetype_level 时填字段名，否则 null。",
  "- quoted_span：逐字摘录题面中支撑你判断的原话。what_not_why：题目问“为什么”时 true。",
  "- assumptions：题面没说、你为搭局面补充的设定（对所有分支都成立的），字符串数组。",
  "- extra_cards：用到“题目中的卡”和“填充卡”以外的卡时，列出 {\"code\":卡号,\"name\":引擎卡库正式名}；没有则为空数组。",
  "- sub_questions[].unrepresentable：能搭出局面时为 null；搭不出时写明是哪个前置条件，此时 branches 为空数组。",
  "- branches[].assumption：该分支独有的假设，没有则为 null。observe：一句话说明看日志里的什么。",
  "",
  "## 适用性（由你判断）",
  "引擎只对具体实例有意义：确定的卡、确定的局面和操作，问“会发生什么 / 能不能”。下列题型判 not_applicable（sub_questions 为空数组）：",
  "- pure_rule：只问一条规则或术语，不针对具体卡的具体局面。",
  "- archetype_level：问一整个字段的卡（例如“斩机怪兽”），而不是具体某张卡；archetype_name 填字段名。不要挑一张卡代表整个字段。",
  "- tournament_policy：比赛规程、裁判处理、判罚。",
  "- ruleset_version：题面明确提到 TCG、历史时点、旧卡文或禁限表时才用。用英文或日文提问不等于问 TCG。",
  "涉及具体卡、但前置状态搭不出来（处于伤害步骤中、本回合已通常召唤、本回合刚盖放、已用过每回合一次、连锁进行中、“之前曾经……”）不是 not_applicable：判 applicable。",
  "题目结论依赖的前置条件（例如“刚盖放”“本回合已召唤”“某效果已发动并处理完”“处于某个连锁或时点”）要用 setup 动作打出来；与结论无关的来历（怪兽怎么上的场、卡是哪个回合盖的）可以直接预置，并写进 assumptions。缺少辅助卡时先从“相关卡”“通用工具卡”里找，再考虑 extra_cards。确实无法打出时才在该子问题 unrepresentable 写明是哪个前置条件、branches 为空。不得用会改变结论的近似局面冒充。",
  "一题多问：拆成多个 sub_questions，各自搭局面。某个假设会改变结论时，最多 2 个分支（同一子问题下），各分支写清 assumption；不要选优或合并。",
  "",
  "## 卡号",
  "只能使用：①“题目中的卡”；②“填充卡”；③“相关卡”（从题目卡的卡文里按「」名称机械取出的卡与字段成员）；④“通用工具卡”；⑤你在 extra_cards 里写明卡号和引擎卡库正式名的其他卡（会被逐字核对，写错算失败）。题面没有点名、只需要“一只怪兽”时用填充卡，并写进 assumptions。",
  "",
  "## scenario（局面）",
  "格式：{\"schema\":\"ocg-repro-scenario/v1\",\"seed\":整数,\"first_player\":0或1,\"players\":[P0,P1]}。P0 = 提问者（“我/我方/自己”），P1 = 对方。题目说“对方回合”时 first_player=1。",
  "玩家：{\"lp\":8000,\"draw_count\":0,\"hand\":[卡号],\"deck\":[卡号（第一个在最上面）],\"extra\":[额外卡组卡号],\"grave\":[卡号],\"removed\":[{\"code\":卡号,\"position\":\"faceup\"}],\"mzone\":[{\"seq\":0-4（5、6 是额外怪兽区）,\"code\":卡号,\"position\":\"faceup_attack|faceup_defense|facedown_defense\",\"summon\":{\"type\":\"normal|advance|flip|special|fusion|synchro|xyz|link|ritual|pendulum\",\"from\":\"hand|deck|extra|grave|removed\"},\"overlay\":[卡号],\"counters\":[{\"type\":\"0x..\",\"count\":n}]}],\"szone\":[{\"seq\":0-4,\"code\":卡号,\"position\":\"faceup|facedown\",\"equip_to\":{\"player\":0,\"zone\":\"mzone\",\"seq\":n},\"targets\":[{\"player\":0,\"zone\":\"mzone\",\"seq\":n}]}],\"fzone\":{\"code\":卡号,\"position\":\"faceup|facedown\"},\"pzone\":[左或null,右或null]}。不用的字段省略。",
  "对局从 first_player 第 1 回合的抽卡阶段开始，该回合允许攻击；卡组不洗切。draw_count 建议 0（不抽卡）。每名玩家卡组至少放 5 张（可用填充卡），检索/抽卡效果需要的卡要放进卡组。",
  "预置在怪兽区的怪兽视为已正规召唤；预置的盖卡可以立即发动（它没有“本回合刚盖放”的状态）。“本回合刚盖放”“本回合已通常召唤”这类状态必须用 setup 动作打出来。连接/超量/同调/融合怪兽放在额外卡组（extra），场上的按其召唤方式预置。",
  "",
  "## actions（操作）",
  "格式：{\"schema\":\"ocg-repro-actions/v1\",\"setup\":[步骤],\"probes\":[探测]}。",
  "步骤：{\"player\":0或1,\"decision\":决策类型,\"choose\":{...},\"note\":\"可选说明\"}。决策类型与 choose：",
  "- idle（主要阶段行动）：{\"cmd\":\"activate|summon|spsummon|repos|mset|sset|to_bp|to_ep\",\"card\":卡号,\"from\":区域}",
  "- battle（战斗阶段行动）：{\"cmd\":\"activate|attack|to_m2|to_ep\",\"card\":卡号}",
  "- chain（连锁/发动窗口）：{\"card\":卡号,\"from\":区域}（同卡多个效果时加 \"desc\"）",
  "- effect_yn / yesno：{\"answer\":true或false}",
  "- select_card / select_tribute / select_sum：{\"cards\":[{\"card\":卡号,\"from\":区域,\"controller\":0或1}]}",
  "- select_unselect（逐张选）：每一步 {\"cards\":[一张]} 或 {\"finish\":true}",
  "- select_place：{\"place\":{\"player\":0或1,\"zone\":\"mzone|szone\",\"seq\":n}}（必须选一个空位）",
  "- select_position：{\"position\":\"faceup_attack|faceup_defense|facedown_defense\"}",
  "- select_option：{\"option\":描述编号}；sort_card：{\"order\":[...]}",
  "区域取值：hand, deck, grave, removed, extra, mzone, szone, fzone, pzone, overlay。卡的过滤只写需要的字段。",
  "回放规则（引擎逐个决策点检查）：",
  "1. 用下一个 setup 步骤匹配当前决策（玩家与决策类型都要一致）：唯一匹配就执行；匹配到多个就失败（选项不唯一）。",
  "2. 不匹配、且该决策可以放弃（没有必发项的连锁窗口；核心发出的“是否发动诱发效果”询问）→ 自动放弃，记录“此时本可发动”。所以 setup 里不要写“放弃/pass”，只写你要做的选择。",
  "3. 不匹配、且不可放弃（行动选择、选区域、选卡、选表示形式、选选项、其他是否询问）→ setup 还没用完就失败并列出合法选项；setup 用完则回放正常结束。",
  "4. 引擎不会替任何人默认选择。凡是需要玩家做的选择都要写成步骤，包括选区域。",
  "已实测的决策顺序（P 为操作者）：",
  "- 通常召唤：idle summon → select_place(自己 mzone 空位) → 之后的连锁窗口自动处理。上级召唤在 select_place 前有 select_tribute。",
  "- 从手卡发动魔法：idle activate → select_place(自己 szone 空位) → [发动时要选的对象：select_card] → 对方/自己的连锁窗口 → 处理时的选择（如检索：select_card 选卡组的卡）。",
  "- 发动场上已盖放的卡：在对应的 chain 窗口（或自己主要阶段的 idle activate）选它，不需要 select_place。",
  "- 盖放魔陷：idle sset → select_place。盖放怪兽：idle mset → select_place。",
  "- 攻击：idle to_bp → battle attack → select_card(攻击对象；直接攻击时没有这一步)。",
  "- 特殊召唤到场上（效果处理时）：通常会有 select_place，有时还有 select_position。",
  "- 两个以上必发效果同时触发时要选处理顺序（chain 窗口里依次选）。",
  "probes（探测，题目问“能不能发动/选择”时用）：{\"after\":k,\"player\":0或1,\"decision_kind\":\"idle|battle|chain|effect_yn|yesno\",\"target\":{\"card\":卡号,\"cmd\":\"可选\",\"desc\":可选}}。观察区间 = setup 第 k 步执行之后到第 k+1 步执行之前（k 等于 setup 长度时到回放结束）。结果：出现 / 出现（核心自动发动） / 未出现 / 未到达。题目问“处理结果如何”时可以不设探测，靠日志展示。",
  "seed：任意整数，分支之间用同一个 seed。",
].join("\n");

export const PROMPT_VERSION = createHash("sha256").update(PLANNER_INSTRUCTIONS).digest("hex").slice(0, 12);

export function buildPlannerInput({ question, cards, relatedCards = [], toolCards = [], includeOfficialQa = false, officialQa = [] }) {
  const parts = ["## 题目（原文）", question, "", "## 题目中的卡（身份已确认）"];
  for (const card of cards) {
    parts.push(JSON.stringify(compactCard(card)));
  }
  parts.push("", "## 填充卡", JSON.stringify(FILLER_CARDS));
  if (relatedCards.length) parts.push("", "## 相关卡", ...relatedCards.map((item) => JSON.stringify(item)));
  if (toolCards.length) parts.push("", "## 通用工具卡", ...toolCards.map((item) => JSON.stringify(item)));
  if (includeOfficialQa && officialQa.length) {
    parts.push("", "## 相关官方 Q&A（消融开关打开时才提供）", ...officialQa.map((item) => JSON.stringify(item)));
  }
  parts.push("", "按上面的格式输出 JSON。");
  return parts.join("\n");
}

function compactCard(card) {
  const out = { code: card.code, name: card.engineName, mentioned_as: card.mentionedAs || [] };
  for (const key of ["types", "level", "rank", "link_rating", "atk", "def", "attribute", "race", "scale", "setnames"]) {
    if (card.engine?.[key] !== undefined) out[key] = card.engine[key];
  }
  if (card.effectText) out.card_text = card.effectText;
  if (card.pendulumEffectText) out.pendulum_text = card.pendulumEffectText;
  if (card.engine?.effect_descs?.length) out.effect_descs = card.engine.effect_descs;
  return out;
}

export function buildRepairInput({ plannerInput, previousPlan, failures }) {
  return [
    plannerInput,
    "",
    "## 上一次的计划（JSON）",
    JSON.stringify(previousPlan),
    "",
    "## 引擎执行失败的分支（只允许修复这一次）",
    ...failures.map((failure) => JSON.stringify(failure)),
    "",
    "只修复上面失败的分支：输出完整 JSON（同样格式），sub_questions 里只放需要修复的子问题与分支（保持原 id），其余字段照抄上一次的计划。",
    "失败是“找不到选项/选项不唯一”时，按列出的合法选项改写 setup（补上缺少的选择步骤，或用 from/seq/desc 区分）；是格式或局面错误时按 problems 改正。不要改变题意，不要换成题面没有的情形。",
  ].join("\n");
}
