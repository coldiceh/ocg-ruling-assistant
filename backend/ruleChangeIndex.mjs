export const RULE_CHANGE_INDEX = Object.freeze([
  {
    id: "ignition_priority_removed_ocg_2011",
    issueFrames: ["activation_legality", "priority", "ignition_effect"],
    effectiveFrom: "2011-03-19",
    precision: "day",
    format: "ocg",
    ruleEra: "post_2011_ocg_ignition_priority",
    summary: "召唤成功时不能再直接以优先权发动通常的怪兽起动效果。",
  },
  {
    id: "extra_deck_zone_revision_2020",
    issueFrames: ["extra_deck_summon_zone", "fusion_summon", "synchro_summon", "xyz_summon", "link_summon", "pendulum_summon"],
    effectiveFrom: "2020-04-01",
    precision: "day",
    format: "ocg",
    ruleEra: "mr2020_revision",
    summary: "融合、同调、超量从额外卡组特殊召唤时不再必须放到额外怪兽区或连接箭头指向区；连接怪兽和从额外卡组表侧特殊召唤的灵摆怪兽仍受限制。",
  },
  {
    id: "trigger_effect_location_change_update",
    issueFrames: ["trigger_effect", "location_change_before_activation", "saved_trigger"],
    effectiveFrom: "2021",
    precision: "year",
    format: "tcg",
    ruleEra: "current",
    summary: "诱发效果满足条件但还未能发动期间，若区域改变，则不发动。",
  },
  {
    id: "trap_monster_zone_update",
    issueFrames: ["trap_monster", "zone_occupancy"],
    effectiveFrom: "2021",
    precision: "year",
    format: "tcg",
    ruleEra: "current",
    summary: "仍当作陷阱使用的陷阱怪兽只占怪兽区，不同时占魔法与陷阱区。",
  },
]);

export function findRuleChangesForIssueFrames(issueFrames = [], index = RULE_CHANGE_INDEX) {
  const ids = new Set((issueFrames || []).map((item) => typeof item === "string" ? item : item?.id).filter(Boolean));
  return index.filter((change) => change.issueFrames.some((id) => ids.has(id)));
}
