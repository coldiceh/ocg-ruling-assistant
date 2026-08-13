const CARD_PASSCODE = /^[0-9]{1,10}$/u;
const MAX_CARD_PASSCODE = 0xffff_ffffn;

/**
 * Normalize the non-zero uint32 card password used by card data providers and
 * c{password}.lua filenames. Short values retain the conventional eight-digit
 * display form; nine- and ten-digit uint32 values remain unchanged.
 */
export function normalizeCardPasscode(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!CARD_PASSCODE.test(text)) return null;
  const numeric = BigInt(text);
  if (numeric === 0n || numeric > MAX_CARD_PASSCODE) return null;
  const canonical = numeric.toString(10);
  return canonical.length < 8 ? canonical.padStart(8, "0") : canonical;
}
