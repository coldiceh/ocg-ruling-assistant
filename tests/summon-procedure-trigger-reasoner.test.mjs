import assert from "node:assert/strict";
import test from "node:test";
import { resolveUniqueEntityFragment } from "../backend/scenarioEntityResolver.mjs";

test("unique fragment binding rejects generic nouns but accepts a grounded prior short form", () => {
  const entities = [{
    id: "saint",
    name: "测试静音使者",
    names: ["测试静音使者"],
  }, {
    id: "dragon",
    name: "测试示例龙",
    names: ["测试示例龙"],
  }];
  for (const fragment of ["龙", "测", "族怪兽", "卡", "手牌"]) {
    assert.equal(resolveUniqueEntityFragment(fragment, entities).status, "unresolved", fragment);
  }
  assert.equal(resolveUniqueEntityFragment("使者", entities).status, "unresolved");
  const query = "记录「测试静音使者」。随后引用使者。";
  const referenceIndex = query.lastIndexOf("使者");
  const grounded = resolveUniqueEntityFragment("使者", entities, { query, referenceIndex });
  assert.equal(grounded.status, "bound", JSON.stringify(grounded));
  assert.deepEqual(grounded.entityIds, ["saint"]);
});
