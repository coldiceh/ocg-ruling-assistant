# TCG rulings

Select **TCG** in the question form to use Yu-Gi-Oh! TCG sources. The answer language is a separate setting. API clients can send `ruleSystem: "TCG"`; omitting it selects OCG. The prepared evidence fixes both the ruleset and answer language through finalization.

## Sources and versions

The independent TCG snapshot contains the [official Rulebook Version 10](https://www.yugioh-card.com/en/downloads/rulebook/SD_RuleBook_EN_10.pdf), [2021 Rules Update](https://www.yugioh-card.com/en/play/2021_rules_update/), [Fast Effect Timing](https://www.yugioh-card.com/en/play/fast-effect-timing/) and its diagram, official PSCT articles, Damage Step guidance, and the Rivalry of Warlords / Gozen Match FAQ. Each record retains its source URL, ruleset, region, language and available version/date metadata. Unknown publication or effective dates remain unknown; capture dates do not replace them. The current source catalog records captures from October 2026.

Card effects come from the [KONAMI TCG card database](https://www.db.yugioh-card.com/yugiohdb/card_search.action?request_locale=en). Shared card names do not make OCG card text or OCG Japanese Q&A TCG evidence. Card text proves the printed effect; it does not by itself establish a general timing rule or an official ruling for the question.

## Card names

English official names and supported nicknames locate catalog candidates. Exact Chinese or Japanese formal names and aliases may use the stable KONAMI CID to find the corresponding TCG entry; only the target TCG effect text is delivered. Other proposed identities use the existing model confirmation step with target card texts. Search rank offers candidates and does not choose an identity. Missing or unselected identities remain unconfirmed.

Descriptions that name an archetype and card kind use the catalog's declared metadata to offer a small candidate list. Official Spell/Trap subtypes map to the shared matcher properties. A generic word such as “field” does not identify a particular card. CID identifies the database entry and is not an image passcode; TCG card images are not currently supplied automatically.

## API and data maintenance

`POST /api/answer` accepts `{"question":"…","ruleSystem":"TCG","answerLocale":"en"}`. Valid answer locales are `zh-CN`, `en`, and `ja`. The web interface uses streamed `prepare` followed by `finalize`; see [backend deployment](backend-deployment.md) for the request protocol.

`data/tcg` holds its own snapshots, revision manifest, compressed runtime, retrieval assets and nickname vocabulary. The runtime supplies both preparation and card lookup; raw snapshots are omitted from deployed answer/card functions. `TCG_DATA_DIR` can select another complete, consistently versioned TCG asset set. `TCG_DATA_REVISION` can declare its revision. TCG cache keys and source assets are independent of OCG. The daily TCG synchronization workflow stages snapshots; model-generated retrieval assets must be prepared before publishing an updated version.

## Limitations

The source set covers ordinary TCG card and effect handling. It is not a complete official per-card Q&A archive, and a relevant rule may be absent from the final evidence package even when stored locally. The assistant should state the missing basis when the delivered evidence cannot support every part of a question. Source authority and a model's selected status do not certify correctness.

Event policy, penalties, deck legality, regional exceptions, Speed Duel and other formats need their own current applicable sources. Answer quality across a broad question set has not yet been established. Always inspect the cited original sources for disputed rulings.
