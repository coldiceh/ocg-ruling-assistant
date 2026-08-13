import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCardPasscode } from "../backend/cardPasscode.mjs";
import { normalizeLegacyLuaPasscode } from "../backend/legacyLuaSemanticPacket.mjs";

test("card passcodes use one neutral non-zero uint32 normalization contract", () => {
  const cases = [
    [undefined, null],
    ["", null],
    ["0", null],
    ["00000000", null],
    ["1", "00000001"],
    ["00000123", "00000123"],
    ["12345678", "12345678"],
    ["123456789", "123456789"],
    ["4294967295", "4294967295"],
    ["4294967296", null],
    ["12x34", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeCardPasscode(input), expected, String(input));
    assert.equal(normalizeLegacyLuaPasscode(input), expected, String(input));
  }
});
