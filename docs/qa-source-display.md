# Verified Q&A source display

`QA_SOURCE_DISPLAY_ENABLED=true` enables a model-facing reading view after bounded evidence selection. Selection, source identity, original records and model-call counts are unchanged. The production setting is in `vercel.json`; leaving it unset or setting it to `false` restores the previous renderer.

The view groups existing question and answer fields, removes only exactly reconstructible duplicates, and resolves card placeholders from the existing runtime card catalog. Older flat records require a version-bound sidecar in `config/qa-source-display-v1.json`: source fields must reconstruct the entire saved body before they can replace its display. Unknown or stale records retain their old representation. The sidecar contains public source material and provenance, not hand-written ruling answers.

The original source title, text and source hash remain canonical. A separate display title connects the model's citations to the website's source list. The same display path applies to initial selection and an already-authorized evidence supplement; it does not change when supplementation is triggered. Prepared finalization sends the exact saved prompt.

The full candidate must fit the existing prompt limit. If its layout is unsupported or its size exceeds that limit, the original complete prompt is used. Character length is not treated as a token-cost guarantee. A five-question paired experiment recorded 28,773 old-format input tokens and 28,936 new-format tokens (+0.5665%); the operator accepted this small observed increase before enabling production. This sample does not guarantee cost or correctness on other inputs.

Only the source display was enabled. There is no extra final-model review call, no larger reading window, no change to the daily budget, and no engine input to the main ruling. The original renderer and raw data remain available for rollback.

Public source mappings can be refreshed explicitly with `scripts/build-qa-source-display.mjs --ids <comma-separated-public-qa-ids>`. A changed upstream body that cannot reconstruct the locally published record fails binding rather than being silently substituted. Updating a map is separate from changing the canonical corpus or its embeddings.
