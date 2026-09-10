import { createHash } from "node:crypto";

// Manual source review records page roles explicitly. These roles are source
// metadata and are consumed mechanically by the activity-source adapters.
export const MANUAL_SOURCE_PAGE_ROLES = Object.freeze({
  "chapters/p01_rule_revision": "table-of-contents",
  "chapters/p02_ocg_rule_base": "table-of-contents",
  "chapters/p03_ocg_rule_more": "table-of-contents",
  "chapters/p04_ocg_card_rule": "table-of-contents",
  pdf_index: "table-of-contents",
  "前言": "site-info",
});

export const MANUAL_SOURCE_TEXT_EDITS = Object.freeze([
  Object.freeze({
    editId: "remove-wechat-card-search-note-v1",
    docname: "c01/大师规则（2017）变更点",
    beforeTextSha256: "995d1ac0febd6f2446f8f26809f23688cdab9ba7cf72f4224573084995ca737a",
    removeText: " 用微信卡查时，需要在 微信小程序-游戏王查卡器-我的-中文译名设置-当前偏好 中调整为NWBBS。\n\n",
  }),
  Object.freeze({
    editId: "remove-pdf-epub-display-note-v1",
    docname: "c03/战斗阶段流程",
    beforeTextSha256: "69ee57b6631e3ee8bfcd3bfe482032e60c8141a1e644823134e3af7ccc481b74",
    removeText: " 以上简表在pdf/epub中暂显示异常，可以参考以下去掉滚动条的全表截图：\n\n",
  }),
  Object.freeze({
    editId: "remove-site-player-praise-note-v1",
    docname: "c01/大师规则（2020年4月版）变更点",
    beforeTextSha256: "3d90bc2387934932f87a8a3a3432ae68a0d05909d42926ab71c05fd7dc78437c",
    removeText: " 以下状况的处理都是本站相关玩家多次询问过的问题，这次的变更整体上大大简化了这些处理，值得好评。\n\n",
  }),
]);

const editByDocname = new Map(MANUAL_SOURCE_TEXT_EDITS.map((edit) => [edit.docname, edit]));

export function isExcludedSourceRole(role) {
  return role === "site-info" || role === "table-of-contents";
}

export function applyManualOcgRuleSourcePolicy({ docname, text, existingRecord } = {}) {
  const name = String(docname || "");
  const original = String(text || "");
  const sourceRole = MANUAL_SOURCE_PAGE_ROLES[name] || "active-rule";
  const edit = editByDocname.get(name);
  if (!edit) return Object.freeze({ text: original, sourceRole });

  const actualHash = sha256(original);
  const first = original.indexOf(edit.removeText);
  if (first < 0 || first !== original.lastIndexOf(edit.removeText)) {
    const alreadyApplied = first < 0
      && existingRecord?.sourceEditId === edit.editId
      && existingRecord?.sourceEditStatus === "applied"
      && existingRecord?.text === original;
    return Object.freeze({
      text: original,
      sourceRole,
      sourceEditId: edit.editId,
      sourceEditBeforeTextSha256: String(
        existingRecord?.sourceEditBeforeTextSha256 || edit.beforeTextSha256,
      ),
      sourceEditObservedTextSha256: alreadyApplied
        ? String(existingRecord?.sourceEditObservedTextSha256 || actualHash)
        : actualHash,
      sourceEditStatus: alreadyApplied ? "applied" : "not-applied",
      ...(alreadyApplied ? {} : {
        sourceEditNotAppliedReason: first < 0 ? "target-missing" : "target-ambiguous",
      }),
    });
  }
  return Object.freeze({
    text: `${original.slice(0, first)}${original.slice(first + edit.removeText.length)}`,
    sourceRole,
    sourceEditId: edit.editId,
    sourceEditBeforeTextSha256: edit.beforeTextSha256,
    sourceEditObservedTextSha256: actualHash,
    sourceEditStatus: "applied",
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
