"""Official TCG snapshots; no model calls, ruling inference or evaluation.

Dependencies for source parsing: lxml and pdfplumber. Source cache stays outside
the deployed/public tree. HTTP validators and canonical record hashes determine
incremental updates; the effect text never determines card metadata.
"""
import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from lxml import html
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
DB = 'https://www.db.yugioh-card.com'
OFFICIAL_HOSTS = {'www.yugioh-card.com', 'www.db.yugioh-card.com', 'img.yugioh-card.com'}


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if path.exists() and path.read_bytes() == body:
        return
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(body)
    temporary.replace(path)


def read_json(path, default):
    return json.loads(path.read_text('utf-8-sig')) if path.exists() else default


class CaptureCache:
    def __init__(self, directory, interval, offline):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.interval, self.offline, self.last = interval, offline, 0
        self.counts = {'requests': 0, 'notModified': 0, 'cached': 0}

    def get(self, url):
        if urlparse(url).hostname not in OFFICIAL_HOSTS:
            raise ValueError('Non-official source URL: ' + url)
        stem = self.directory / digest(url)
        content, metadata = stem.with_suffix('.body'), stem.with_suffix('.json')
        old = read_json(metadata, {})
        if self.offline:
            if not content.exists():
                raise FileNotFoundError('Source not cached: ' + url)
            self.counts['cached'] += 1
            return content.read_bytes(), old
        time.sleep(max(0, self.interval - (time.monotonic() - self.last)))
        headers = {'User-Agent': 'tcg-ruling-assistant-source-sync/1.0', 'Accept-Language': 'en'}
        if old.get('etag') and content.exists(): headers['If-None-Match'] = old['etag']
        if old.get('lastModified') and content.exists(): headers['If-Modified-Since'] = old['lastModified']
        self.last = time.monotonic()
        self.counts['requests'] += 1
        try:
            with urlopen(Request(url, headers=headers), timeout=45) as response:
                if urlparse(response.url).hostname not in OFFICIAL_HOSTS:
                    raise ValueError('Non-official redirect')
                body = response.read()
                saved = {'url': url, 'resolvedUrl': response.url, 'sha256': digest(body),
                         'etag': response.headers.get('ETag'),
                         'lastModified': response.headers.get('Last-Modified'),
                         'capturedAt': datetime.now(timezone.utc).isoformat()}
            content.write_bytes(body)
            write_json(metadata, saved)
            return body, saved
        except HTTPError as error:
            if error.code == 304 and content.exists():
                self.counts['notModified'] += 1
                return content.read_bytes(), old
            raise


def nodes(element, class_name):
    return element.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," ' + class_name + ' ")]')


def text(element):
    # DOM text and explicit <br> encoding only; independent source fields stay separate.
    return re.sub(r'[ \t\r\n]+', ' ', element.text_content()).strip().replace('<br>', '\n').replace('<br />', '\n')


def first_text(element, class_name):
    found = nodes(element, class_name)
    return text(found[0]) if found else ''


def metadata(url, region='North America', version='unknown', source_date='unknown', effective='unknown'):
    return {'ruleSystem': 'TCG', 'region': region, 'sourceLanguage': 'en',
            'sourceVersion': version, 'sourceDate': source_date, 'effectiveAt': effective,
            'sourceUrl': url, 'official': True, 'sourceAuthority': 'official_reference',
            'sourceTier': 'official', 'sourceName': 'KONAMI Yu-Gi-Oh! TCG'}


def parse_catalog(body, url):
    page = html.fromstring(body)
    rows = page.xpath('//*[@id="card_list"]/*[contains(concat(" ",@class," ")," t_row ")]')
    if not rows: raise ValueError('Official catalog rows absent: ' + url)
    cards = []
    for row in rows:
        cid_nodes = nodes(row, 'cid')
        if not cid_nodes: raise ValueError('Catalog CID absent')
        cid = cid_nodes[0].get('value', '')
        if not cid.isdigit(): raise ValueError('Catalog CID invalid')
        name = first_text(row, 'card_name')
        attributes = nodes(row, 'box_card_attribute')
        attribute = attributes[0].xpath('.//img/@alt')[0] if attributes else ''
        species = first_text(row, 'card_info_species_and_other_item').strip('[] ').split('／')
        species = [item.strip() for item in species if item.strip()]
        subtype = first_text(row, 'box_card_effect')
        category = {'SPELL': 'Spell', 'TRAP': 'Trap'}.get(attribute, 'Monster')
        link = first_text(row, 'box_card_linkmarker')
        level_rank = first_text(row, 'box_card_level_rank')
        scale = first_text(row, 'box_card_pen_scale')
        value = lambda field: int(re.search(r'\d+', field).group()) if re.search(r'\d+', field) else None
        detail = nodes(row, 'link_value')[0].get('value')
        detail_url = urljoin(DB, detail) + '&request_locale=en'
        card = {**metadata(detail_url, 'TCG database'), 'id': cid, 'cardId': cid,
                'cid': cid, 'idNamespace': 'konami-cid', 'passcode': '',
                'name': name, 'enName': name, 'aliases': [name],
                'text': first_text(row, 'box_card_text'),
                'pendulumEffectText': first_text(row, 'box_card_pen_effect'),
                'type': category, 'cardType': category,
                'typeLine': ' / '.join(species) if category == 'Monster' else ' / '.join(filter(None, [category, subtype])),
                'types': species[1:] if category == 'Monster' else [subtype],
                'properties': species[1:] if category == 'Monster' else [subtype],
                'monsterProperties': species[1:] if category == 'Monster' else [],
                'source': 'konami-tcg',
                'race': species[0] if category == 'Monster' and species else '',
                'attribute': attribute if category == 'Monster' else '',
                'spellTrapSubtype': subtype, 'level': value(level_rank) if level_rank.startswith('Level ') else None,
                'rank': value(level_rank) if level_rank.startswith('Rank ') else None,
                'link': value(link), 'pendulumScale': value(scale),
                'atk': first_text(row, 'atk_power').removeprefix('ATK ').strip() or None,
                'def': first_text(row, 'def_power').removeprefix('DEF ').strip() or None,
                'linkMarkerImage': nodes(row, 'box_card_linkmarker')[0].xpath('.//img/@src')[0] if link else '',
                'imageUrl': '', 'imageCandidates': [], 'sourceLabel': 'KONAMI TCG database',
                'sourcePageUrl': url}
        if not name: raise ValueError('Catalog name absent')
        cards.append(card)
    page_numbers = [int(n) for n in re.findall(r'ChangePage\((\d+)\)', body.decode('utf-8', errors='replace'))]
    return cards, max(page_numbers, default=1)


def sync_cards(cache, output):
    old = {str(card['id']): card for card in read_json(output / 'cards.json', {}).get('records', [])}
    cards = {}
    pages, page = 1, 1
    while page <= pages:
        url = DB + '/yugiohdb/card_search.action?' + urlencode({'ope': 1, 'sess': 1, 'rp': 100,
            'page': page, 'mode': 1, 'sort': 1, 'keyword': '', 'stype': 1, 'request_locale': 'en'})
        body, capture = cache.get(url)
        rows, declared_pages = parse_catalog(body, url)
        pages = max(pages, declared_pages)
        for card in rows:
            revision = digest(canonical(card))
            previous = old.get(card['id'], {})
            card.update({'dataRevision': 'sha256:' + revision,
                         'updatedAt': previous.get('updatedAt') if previous.get('dataRevision') == 'sha256:' + revision else capture['capturedAt']})
            if card['id'] in cards: raise ValueError('Duplicate CID across catalog pages; rerun from saved captures after inspecting pagination')
            cards[card['id']] = card
        if page == 1 or page % 10 == 0 or page == pages: print(f'Catalog preparation: page {page}/{pages}', flush=True)
        page += 1
    records = sorted(cards.values(), key=lambda card: int(card['id']))
    revision = 'sha256:' + digest(canonical(records))
    write_json(output / 'cards.json', {'schemaVersion': 1, 'ruleSystem': 'TCG',
                                     'revision': revision, 'pages': pages, 'records': records})
    return len(records), revision


def content_root(tree, selector=None):
    if selector:
        found = tree.xpath(selector)
    else:
        found = tree.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," entry-content ")]')
    if len(found) != 1: raise ValueError('Official article content root ambiguous/absent')
    return found[0]


def utf16_length(value):
    return len(value.encode('utf-16-le')) // 2


def faq_body(root):
    # Adapter-defined DOM relation: each list item depends on the actual heading
    # and preceding paragraph nodes in its section. No wording/relevance inference.
    pieces, declarations, context = [], [], []
    offset = 0
    def add(element, required=()):
        nonlocal offset
        value = text(element)
        if not value: return
        value += '\n\n'
        start, end = offset, offset + utf16_length(value)
        declarations.append({'start': start, 'end': end, 'textSha256': digest(value),
                             'domPath': element.getroottree().getpath(element),
                             'requiredContextRanges': list(required)})
        pieces.append(value)
        offset = end
        return [start, end]
    for element in root:
        if not isinstance(element.tag, str): continue
        if re.fullmatch('h[1-6]', element.tag):
            context = []
            item = add(element)
            if item: context.append(item)
        elif element.tag == 'p':
            item = add(element, context)
            if item: context.append(item)
        elif element.tag in ('ul', 'ol'):
            for item in element.xpath('./li'): add(item, context)
        elif element.tag == 'table': add(element, context)
    conclusion = ''.join(pieces)
    return conclusion, {'schemaVersion': 1, 'bodyField': 'conclusion',
                        'bodySha256': digest(conclusion), 'segments': declarations}


def article_body(root, source_id):
    """Serialize observable HTML blocks and heading ranges without inference."""
    pieces, blocks, sections = [], [], []
    offset = 0
    section_stack = []
    root_section = {'sectionKey': source_id + ':root', 'parentKey': None,
                    'title': '', 'start': 0, 'end': 0}
    sections.append(root_section)
    section_stack.append((0, root_section))

    def visit(element):
        nonlocal offset
        if not isinstance(element.tag, str) or element.tag in ('script', 'style'): return
        heading = re.fullmatch(r'h([1-6])', element.tag)
        recognized = heading or element.tag in ('p', 'ul', 'ol', 'table', 'blockquote')
        if not recognized:
            if element.text and element.text.strip():
                add(element.text.strip(), 'paragraph')
            for child in element:
                visit(child)
                if child.tail and child.tail.strip(): add(child.tail.strip(), 'paragraph')
            return
        if heading:
            level = int(heading.group(1))
            while len(section_stack) > 1 and section_stack[-1][0] >= level:
                section_stack.pop()[1]['end'] = offset
            section = {'sectionKey': source_id + ':section:' + str(len(sections)),
                       'parentKey': section_stack[-1][1]['sectionKey'],
                       'title': text(element), 'start': offset, 'end': 0}
            sections.append(section)
            section_stack.append((level, section))
            add(section['title'], 'heading')
        elif element.tag in ('ul', 'ol'):
            add('\n'.join('• ' + text(item) for item in element.xpath('./li')), 'list')
        elif element.tag == 'table':
            # Rows and cell order are preserved, including headers and date notices.
            add('\n'.join(' | '.join(text(cell) for cell in row.xpath('./th|./td'))
                          for row in element.xpath('.//tr')), 'table')
        else:
            add(text(element), 'paragraph')

    def add(value, kind):
        nonlocal offset
        if not value: return
        value += '\n\n'
        end = offset + utf16_length(value)
        blocks.append({'blockKey': source_id + ':block:' + str(len(blocks) + 1),
                       'sectionKey': section_stack[-1][1]['sectionKey'],
                       'kind': kind, 'start': offset, 'end': end})
        pieces.append(value)
        offset = end

    visit(root)
    for _, section in section_stack: section['end'] = offset
    value = ''.join(pieces)
    return value, {'schemaVersion': 2, 'canonicalSha256': digest(value),
                   'sections': sections, 'blocks': blocks}


def sync_rules(cache, output, registry):
    sources = list(registry['sources'])
    psct_url = registry['psctIndex']
    index_bytes, _ = cache.get(psct_url)
    psct_tree = html.fromstring(index_bytes)
    psct_links = content_root(psct_tree).xpath('.//a[@href]')
    for i, link in enumerate(psct_links, 1):
        sources.append({'id': f'tcg-psct-{i}', 'url': urljoin(psct_url, link.get('href')),
                        'title': text(link), 'format': 'html', 'version': f'PSCT part {i}',
                        'sourceDate': {1:'2011-05-20',2:'2011-05-23',3:'2011-06-01',4:'2011-06-01',5:'2011-07-27',6:'2011-08-08',7:'2012-12-12'}.get(i, 'unknown')})
    # Discover Card FAQ links from the official advanced rules directory.
    directory_bytes, _ = cache.get(registry['advancedRulesIndex'])
    directory = content_root(html.fromstring(directory_bytes))
    known = {source['url'] for source in sources}
    for link in directory.xpath('.//a[@href]'):
        url = urljoin(registry['advancedRulesIndex'], link.get('href'))
        if '/card-faq-' in urlparse(url).path and url not in known:
            sources.append({'id': 'tcg-faq-' + urlparse(url).path.strip('/').split('/')[-1],
                            'url': url, 'title': text(link), 'format': 'faq'})
            known.add(url)
    rules, faq, catalog = [], [], []
    for source in sources:
        body, capture = cache.get(source['url'])
        if source['format'] == 'list-index':
            directory = content_root(html.fromstring(body))
            links = [urljoin(source['url'], href) for href in directory.xpath('.//a/@href')
                     if re.fullmatch(r'/en/limited/list_\d{4}-\d{2}-\d{2}/', urlparse(urljoin(source['url'], href)).path)]
            if len(links) != 1: raise ValueError('Current official Forbidden/Limited list link ambiguous/absent')
            source = {**source, 'url': links[0], 'format': 'html', 'version': urlparse(links[0]).path.split('/')[-2]}
            body, capture = cache.get(source['url'])
        meta = metadata(source['url'], source.get('region', 'North America'),
                        source.get('version', 'unknown'), source.get('sourceDate', 'unknown'),
                        source.get('effectiveAt', 'unknown'))
        catalog.append({**source, **meta, 'capture': capture})
        if source['format'] == 'pdf':
            stem = cache.directory / digest(source['url'])
            with pdfplumber.open(stem.with_suffix('.body')) as pdf:
                for number, page in enumerate(pdf.pages, 1):
                    # The visually confirmed v10 PDF uses two printed pages per
                    # spread after its cover. Preserve left/right reading order.
                    halves = [('cover', page)] if number == 1 else [
                        ('left', page.crop((0, 0, page.width / 2, page.height))),
                        ('right', page.crop((page.width / 2, 0, page.width, page.height)))]
                    for half, region in halves:
                        value = region.extract_text() or ''
                        if not value: continue
                        rules.append({**meta, 'id': f"{source['id']}-pdf-{number}-{half}", 'recordType': 'rule-doc',
                                      'sourceId': source['id'], 'title': f"{source['title']} / PDF page {number} {half}",
                                      'text': value, 'sourceHtmlSha256': capture['sha256'],
                                      'sourceUrl': source['url'] + f'#page={number}', 'page': number, 'pageHalf': half})
        else:
            tree = html.fromstring(body)
            root = content_root(tree, source.get('contentSelector'))
            if source['format'] == 'faq':
                conclusion, declaration = faq_body(root)
                title_nodes = tree.xpath('//h1')
                published_title = text(title_nodes[0]) if title_nodes else source['title']
                card_names = re.findall(r'[“\"]([^”\"]+)[”\"]', published_title)
                catalog_cards = read_json(output / 'cards.json', {}).get('records', [])
                by_name = {card['name']: card['id'] for card in catalog_cards}
                ownership_ids = [by_name[name] for name in card_names if name in by_name]
                faq.append({**meta, 'id': source['id'], 'recordType': 'card-faq',
                            'title': published_title, 'conclusion': conclusion,
                            'sourceStructure': declaration, 'cardIds': ownership_ids, 'cards': card_names})
            else:
                # Preserve table headers, rows, paragraphs and all independent fields.
                clone = html.fromstring(html.tostring(root))
                for node in clone.xpath('.//script|.//style'): node.drop_tree()
                value, structure = article_body(clone, source['id'])
                rules.append({**meta, 'id': source['id'], 'recordType': 'rule-doc',
                              'sourceId': source['id'], 'title': source['title'], 'text': value,
                              'sourceHtmlSha256': capture['sha256'], 'structure': structure})
            for image in root.xpath('.//img[@src]'):
                image_url = urljoin(source['url'], image.get('src'))
                # Save original source diagrams as assets; their captions/URLs are
                # provenance, not an invented textual interpretation of the image.
                if image_url in source.get('diagramUrls', []):
                    image_bytes, image_capture = cache.get(image_url)
                    target = output / 'source-diagrams' / Path(urlparse(image_url).path).name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(image_bytes)
                    catalog.append({'id': source['id'] + '-diagram', **meta, 'sourceUrl': image_url,
                                    'format': 'image', 'asset': str(target.relative_to(output)), 'capture': image_capture})
        print('Prepared official source: ' + source['id'], flush=True)
    diagram = read_json(ROOT / 'config/tcg-fast-timing-chart.json', {})
    diagram_bytes, _ = cache.get(diagram['sourceUrl'])
    if digest(diagram_bytes) != diagram['sourceSha256']:
        raise ValueError('Official timing diagram changed; update the source transcription before publishing')
    rules.append({**metadata(diagram['sourceUrl']), 'id': 'tcg-fast-timing-diagram',
                  'recordType':'rule-doc', 'sourceId':'tcg-fast-timing-diagram',
                  'title':'Official Fast Effect Timing diagram: labels and arrows',
                  'text':diagram['text'], 'sourceRepresentation':diagram['representation'],
                  'sourceImageSha256':diagram['sourceSha256']})
    # Existing shared loader contract keeps this historical filename in each
    # isolated directory; every record still explicitly declares TCG authority.
    for name, records in [('ocg-rule-corpus.json', rules), ('qa-index.json', faq),
                          ('rulings.json', []), ('evidence-index.json', []), ('official-responses.json', [])]:
        write_json(output / name, {'schemaVersion': 1, 'ruleSystem': 'TCG', 'records': records})
    write_json(output / 'source-catalog.json', {'schemaVersion': 1, 'ruleSystem': 'TCG', 'sources': catalog})
    return len(rules), len(faq)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data/tcg')
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--interval-seconds', type=float, default=1.0)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--only', choices=['cards', 'rules', 'all'], default='all')
    args = parser.parse_args()
    if args.interval_seconds < 0.5: parser.error('Minimum source request interval is 0.5 seconds')
    output = args.data_dir.resolve()
    cache = CaptureCache(args.cache_dir.resolve(), args.interval_seconds, args.offline)
    result = {'ruleSystem': 'TCG', 'modelCalls': 0}
    if args.only in ('cards', 'all'): result['cards'], result['cardRevision'] = sync_cards(cache, output)
    if args.only in ('rules', 'all'):
        registry = read_json(ROOT / 'config/tcg-sources.json', {})
        result['rules'], result['faq'] = sync_rules(cache, output, registry)
    result['http'] = cache.counts
    write_json(output / 'sync-report.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__': main()
