# Yu-Gi-Oh! OCG AI Rulings

[中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[Use online](https://coldiceh.github.io/ocg-ruling-assistant/) · [Report an issue](https://github.com/coldiceh/ocg-ruling-assistant/issues)

Yu-Gi-Oh! OCG AI Rulings helps OCG players analyze ruling questions with card text, publicly available rule materials, and official Q&A, while keeping the supporting sources visible.

It is not an official KONAMI project and does not replace an event judge.

## What it can do

- Analyze questions about card activation, Chains, effect resolution, timing, replacement effects, and related interactions.
- Confirm the cards and card text involved, then let you correct or add anything uncertain.
- Let you choose the ruling model and reasoning level.
- Present a conclusion, reasoning, cited sources, and anything that still needs confirmation.
- Download the collected evidence without requesting a ruling, so you can ask another AI yourself.
- Provide an unconfirmed analysis from complete effect text supplied by the user when a new card is not yet in the database.

## How to use it

1. Enter the complete question, including the game state, sequence of actions, and the ruling point you want to confirm.
2. Check the identified cards and card text. Add or correct the full effect text if something is missing or a new card is not yet available.
3. Choose a ruling model and reasoning level, then start the analysis.
4. Read the conclusion, reasoning, and cited evidence, and open the sources when you need to verify the original text.
5. If you only need the materials, download the collected evidence and use it with another AI of your choice.

AI can misread rules, miss conditions, or reach an incorrect conclusion, so answers are not guaranteed to be correct. Check the displayed evidence, and rely on official materials and the judge on site for tournament decisions.

| Model | Answer mode | Accuracy | Mean time (s) | Median answer time (s) | P95 answer time (s) | Average per question (USD) |
|---|---|---:|---:|---:|---:|---:|
| Astra low | Evidence-assisted | 50/50 (100%) | (76.11 + 10.78) | 10.30 | 16.98 | $0.094601 |
| Astra low | Direct answer | 33/50 (66%) | 22.69 | 17.57 | 48.71 | $0.036693 |
| DeepSeek V4.1 Flash max | Evidence-assisted | 41/50 (82%) | (76.11 + 111.58) | 93.93 | 231.25 | $0.009158 |
| DeepSeek V4.1 Flash max | Direct answer | 10/50 (20%) | 198.54 | 168.71 | 446.76 | $0.015915 |
| GLM 5.3 Flash max | Evidence-assisted | 37/50 (74%) | (76.11 + 468.29) | 353.75 | 998.49 | $0.013171 |
| GLM 5.3 Flash max | Direct answer | 3/50 (6%) | 1003.99 | 946.43 | 2166.98 | $0.024208 |

[Full questions and answers](https://coldiceh.github.io/ocg-ruling-assistant/assets/benchmarks/ocg-50-20260924.html)

## Data and reference sources

- [Official Yu-Gi-Oh! OCG Card Database and Q&A](https://www.db.yugioh-card.com/yugiohdb/)
- Publicly accessible card text, FAQs, rulebooks, and rule-learning materials

## Disclaimer

This is not an official KONAMI project. Its analysis may contain errors, omissions, or incorrect conclusions. For tournaments, local events, and official events, follow the official rules, the official database, the event organizer, and the judges on site.
