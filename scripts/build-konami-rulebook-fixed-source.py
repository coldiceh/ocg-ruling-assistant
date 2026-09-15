#!/usr/bin/env python3
"""Assemble visually reviewed page checkpoints into one fixed rule source."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path


SOURCE_URL = "https://www.yugioh-card.com/japan/howto/data/rulebook_masterrule20200401_ver1.0.pdf"
SOURCE_PDF_SHA256 = "d8fd0165bc5aa92880f934993de8b472b426dcb07b3588f3bbf2ddceaae0e8d6"
SOURCE_MARKED_HEADING = re.compile(
    r"(?m)^(?:[●■][^\n]+|＜[^＞\n]+＞|［[^］\n]+］)$"
)


def digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_pages(inputs: list[Path]) -> list[dict[str, object]]:
    pages: dict[int, dict[str, object]] = {}
    for path in inputs:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("sourceUrl") != SOURCE_URL or payload.get("sourcePdfSha256") != SOURCE_PDF_SHA256:
            raise ValueError(f"Source binding mismatch: {path}")
        for source_page in payload.get("pages", []):
            page = dict(source_page)
            printed_page = int(page.get("printedPage", 0))
            if printed_page in pages:
                raise ValueError(f"Duplicate printed page {printed_page}: {path}")
            if "body" in page:
                body = str(page.get("body") or "").strip()
                source_headings = [str(value).strip() for value in page.get("sourceHeadings") or []]
                if any(not value for value in source_headings):
                    raise ValueError(f"Empty reviewed source heading on printed page {printed_page}: {path}")
                # This artifact schema keeps visually confirmed source
                # headings out of body. Explanatory page titles are never
                # serialized. Only the explicit sourceHeadings field is.
                if source_headings:
                    heading_text = "\n".join(source_headings)
                    body = f"{heading_text}\n\n{body}"
            else:
                body = str(page.get("text") or "").strip()
            status = str(page.get("reviewStatus") or "")
            if not body:
                raise ValueError(f"Empty reviewed body on printed page {printed_page}: {path}")
            if "review" not in status and "transcribed" not in status:
                raise ValueError(f"Page {printed_page} is not visually reviewed: {status}")
            page["text"] = body
            page["artifact"] = path.name
            pages[printed_page] = page
    expected = set(range(1, 95))
    missing = sorted(expected - set(pages))
    extra = sorted(set(pages) - expected)
    if missing or extra:
        raise ValueError(f"Reviewed page coverage mismatch: missing={missing}, extra={extra}")
    return [pages[index] for index in range(1, 95)]


def assemble_text(pages: list[dict[str, object]]) -> tuple[str, dict[int, tuple[int, int]]]:
    chunks: list[str] = []
    ranges: dict[int, tuple[int, int]] = {}
    cursor = 0
    previous: dict[str, object] | None = None
    for page in pages:
        printed_page = int(page["printedPage"])
        if page.get("rulingIndexEligible") is False:
            continue
        previous_page = int(previous["printedPage"]) if previous else 0
        continuation = (
            int(page.get("continuesFromPrintedPage") or 0) == previous_page
            or bool(previous and previous.get("continuesToNextPage"))
            or int(previous.get("continuesToPrintedPage") or 0) == printed_page
            if previous
            else False
        )
        separator = "" if continuation else ("\n\n" if chunks else "")
        body = str(page["text"])
        start = cursor + len(separator)
        chunks.append(separator + body)
        cursor += len(separator) + len(body)
        ranges[printed_page] = (start, cursor)
        previous = page
    return "".join(chunks).rstrip() + "\n", ranges


def is_continuation(page: dict[str, object], previous: dict[str, object] | None) -> bool:
    if not previous:
        return False
    printed_page = int(page["printedPage"])
    previous_page = int(previous["printedPage"])
    return (
        int(page.get("continuesFromPrintedPage") or 0) == previous_page
        or bool(previous.get("continuesToNextPage"))
        or int(previous.get("continuesToPrintedPage") or 0) == printed_page
    )


def build_sections(
    pages: list[dict[str, object]],
    text: str,
    page_ranges: dict[int, tuple[int, int]],
) -> list[dict[str, object]]:
    chapter_specs = [
        ("front-matter", "ルールブック案内・ゲームの特徴", 1, 2),
        ("beginner", "初級編 デュエルの基本を学ぼう", 3, 28),
        ("intermediate", "中級編 いろいろなカードについて知ろう", 29, 61),
        ("advanced", "上級編 大会向けのルールについて知ろう", 62, 91),
    ]
    sections: list[dict[str, object]] = []
    for chapter_id, title, first_page, last_page in chapter_specs:
        chapter_start = page_ranges[first_page][0]
        chapter_end = page_ranges[last_page][1]
        sections.append(
            {
                "id": chapter_id,
                "title": title,
                "level": 1,
                "parentId": None,
                "sourceFragment": f"page={(first_page + 1) // 2}-{(last_page + 1) // 2}",
                "printedPages": [first_page, last_page],
                "start": chapter_start,
                "end": chapter_end,
            }
        )

        candidates: dict[int, tuple[str, int]] = {}
        previous: dict[str, object] | None = None
        for page in pages:
            printed_page = int(page["printedPage"])
            if printed_page < first_page or printed_page > last_page:
                continue
            page_start, _page_end = page_ranges[printed_page]
            body = str(page["text"])
            for match in SOURCE_MARKED_HEADING.finditer(body):
                candidates[page_start + match.start()] = (match.group(0), printed_page)
            for source_heading in page.get("sourceHeadings") or []:
                heading = str(source_heading)
                occurrences = [
                    match.start()
                    for match in re.finditer(
                        rf"(?m)^{re.escape(heading)}$",
                        body,
                    )
                ]
                if len(occurrences) != 1:
                    raise ValueError(
                        f"Reviewed source heading must occur exactly once on printed page {printed_page}: {heading}"
                    )
                candidates[page_start + occurrences[0]] = (heading, printed_page)
            previous = page

        starts = sorted(candidates)
        for index, start in enumerate(starts):
            title, printed_page = candidates[start]
            end = starts[index + 1] if index + 1 < len(starts) else chapter_end
            if start >= end:
                raise ValueError(f"Invalid reviewed source-heading range at printed page {printed_page}")
            sections.append(
                {
                    "id": f"{chapter_id}-source-heading-{index + 1}",
                    "title": title,
                    "level": 2,
                    "parentId": chapter_id,
                    "sourceFragment": f"page={(printed_page + 1) // 2}",
                    "printedPages": [printed_page, printed_page],
                    "start": start,
                    "end": end,
                }
            )
    return sections


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    pages = load_pages(args.input)
    text, page_ranges = assemble_text(pages)
    sections = build_sections(pages, text, page_ranges)
    record = {
        "id": "konami:ocg-rulebook-20200401",
        "recordType": "rule-doc",
        "title": "遊戯王OCG 公式ルールブック（2020年4月1日改訂版）",
        "sourceName": "KONAMI 遊戯王OCG",
        "sourceUrl": SOURCE_URL,
        "sourceAuthority": "official_reference",
        "official": True,
        "text": text,
        "structure": {
            "schemaVersion": 1,
            "canonicalSha256": digest_text(text),
            "sections": sections,
        },
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "originalPdfSha256": SOURCE_PDF_SHA256,
        "extraction": {
            "method": "complete_visual_transcription_from_rendered_official_pdf",
            "scope": "All 94 printed pages represented by the 47-page official PDF; canonical rule text covers printed pages 1-91.",
            "convention": "Furigana, running chapter tabs, printed page numbers, decorative card-art microtext, and layout-only line wrapping are omitted. Source headings, prose, lists, tables/diagrams represented in reviewed structural blocks, punctuation, and reading order are retained.",
            "pdfPages": [1, 47],
            "printedPages": [1, 94],
            "reviewedPageCount": 94,
            "canonicalRulePrintedPages": [1, 91],
            "reviewedNonRulePrintedPages": [92, 93, 94],
            "pageCheckpoints": [
                {
                    "printedPage": int(page["printedPage"]),
                    "pdfPage": (int(page["printedPage"]) + 1) // 2,
                    "spreadSide": "left" if int(page["printedPage"]) % 2 else "right",
                    "reviewStatus": page.get("reviewStatus"),
                    "textSha256": digest_text(str(page["text"])),
                    "artifact": page["artifact"],
                    "rulingIndexEligible": page.get("rulingIndexEligible") is not False,
                    **(
                        {"sourceRole": str(page["sourceRole"])}
                        if page.get("sourceRole")
                        else {}
                    ),
                    **(
                        {"continuesFromPrintedPage": int(page["continuesFromPrintedPage"])}
                        if page.get("continuesFromPrintedPage")
                        else {}
                    ),
                    **(
                        {"continuesToPrintedPage": int(page["continuesToPrintedPage"])}
                        if page.get("continuesToPrintedPage")
                        else {}
                    ),
                }
                for page in pages
            ],
        },
    }
    args.output.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output} with {len(text)} characters and {len(pages)} reviewed pages")


if __name__ == "__main__":
    main()
