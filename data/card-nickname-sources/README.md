# Card nickname inputs

`../card-nicknames.v1.json` is a generated, literal nickname-to-CID candidate list.
It does not decide which cards a question mentions. Multiple entries for one
nickname are intentional and must stay available to the card-name model.

The ocgbot file is pinned to commit
`dcc1a184e254f97bb31ff265b6e9c8ac309902ee` with its MIT license. Only `nk_type: 0`
single-card rows are eligible. `nk_type: 1` substitution rules are never run or
imported. No fuzzy matching, punctuation folding or regular expression
expansion is used to bind an input target name.

An input target must exactly match a current card name/declared alias, or a
frozen Baige name bridge. A bridge is accepted only when its CID exists in the
current cards and its Japanese name is exactly equal. If the target resolves
to multiple CIDs, it is rejected. If any target of a shared nickname cannot be
resolved, that entire nickname is withheld rather than presenting a partial
candidate set. `小蓝`, for example, retains both CID 14759 and CID 12106.

`identity-bridges.v1.json` contains only the names needed by the pinned
dictionary. Its Baige input hash and download date are in `sources.v1.json`.
The complete downloaded Baige database stays outside the publication tree.
`curated.v1.json` records the separately checked Phoenix and 龟G aliases and
their Japanese identity assertions. It does not copy card effects or articles.

Rebuild offline:

```text
node scripts/build-rag-card-nickname-data.mjs
node scripts/build-rag-card-nickname-data.mjs --check
```

To also verify the frozen bridges against the pinned private Baige input:

```text
node scripts/build-rag-card-nickname-data.mjs --check --baige-json <path-to-pinned-cards.json>
```

`--private-report <path>` writes detailed rejected rows outside the publication
tree. The command otherwise prints counts only. Rebuilding never modifies
`data/cards.json`, the compressed runtime corpus or its revision manifest.

Maintainer updates require a new source revision/hash and a new review of the
identity facts. Source metadata is not evidence that any nickname is globally
unambiguous; all entries remain model reference candidates.
