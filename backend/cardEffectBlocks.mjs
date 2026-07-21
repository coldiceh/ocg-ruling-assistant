const PRIMARY_EFFECT_MARKER = /[①②③④⑤⑥⑦⑧⑨⑩]\s*[：:]|(?:^|\n)\s*\d{1,2}\s*[.．、：:)）]/gu;

export function splitEffectTextBlocks(value) {
  const text = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (!text) return [];
  const markers = [...text.matchAll(PRIMARY_EFFECT_MARKER)].map((match) => {
    const raw = String(match[0] || "");
    const leadingLength = raw.match(/^[\n\s]*/u)?.[0]?.length || 0;
    const marker = raw.slice(leadingLength).trim();
    return {
      index: (match.index ?? 0) + leadingLength,
      marker,
    };
  });
  if (!markers.length) return [{ id: "effect-unmarked", marker: "", text }];

  const blocks = [];
  const preamble = text.slice(0, markers[0].index).trim();
  if (preamble) {
    blocks.push({
      id: "effect-preamble",
      marker: "",
      kind: "preamble",
      text: preamble,
    });
  }
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const start = marker.index;
    const end = markers[index + 1]?.index ?? text.length;
    const markerToken = marker.marker.match(/[①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2}/u)?.[0] || String(index + 1);
    blocks.push({
      id: `effect-${markerToken}`,
      marker: markerToken,
      kind: "effect",
      text: text.slice(start, end).trim(),
    });
  }
  return blocks;
}
