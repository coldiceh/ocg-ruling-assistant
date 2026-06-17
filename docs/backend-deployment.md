# 后端部署

## 本地运行

需要先安装 Node.js 20 或更新版本。

```bash
npm run dev:backend
```

默认接口：

```text
http://localhost:8787/api/answer
```

健康检查：

```text
http://localhost:8787/health
```

## Vercel

仓库包含 `api/answer.js`，导入 Vercel 后会自动成为 Serverless Function。

环境变量：

- `MODEL_PROVIDER`：可选。填 `gemini` 或 `openai`；不填时会优先使用已配置的 Gemini。
- `GEMINI_API_KEY`：可选。设置后启用 Gemini 模型回答。
- `GEMINI_MODEL`：可选但建议和 API key 一起设置。例如 `gemini-2.5-flash`。
- `GEMINI_MODELS`：可选。逗号分隔的 Gemini 文字模型列表；设置后会按顺序尝试，前一个额度耗尽、限速或返回格式异常时自动换下一个。
- `GEMINI_CARD_RESOLUTION_MODELS`：可选。逗号分隔的卡名解析模型列表；建议使用轻量模型，节省主回答模型额度。
- `OPENAI_API_KEY`：可选。设置后启用 OpenAI 模型回答。
- `OPENAI_MODEL`：可选但建议和 API key 一起设置。用于指定当前要用的 OpenAI 模型。
- `ALLOWED_ORIGIN`：可选。建议填 GitHub Pages 域名，例如 `https://coldiceh.github.io`。

Gemini 推荐最小配置：

```text
MODEL_PROVIDER=gemini
GEMINI_API_KEY=你的 Gemini API key
GEMINI_MODELS=gemini-2.5-flash,gemini-3-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite
GEMINI_CARD_RESOLUTION_MODELS=gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash
GEMINI_MAX_OUTPUT_TOKENS=2600
GEMINI_CARD_RESOLUTION_TOKENS=1200
ALLOWED_ORIGIN=https://coldiceh.github.io
```

免费额度优先时，建议保持这个组合。裁定解释优先使用 Flash 系列；卡名解析优先使用 Flash Lite 系列。卡名解析只有在本地资料和实时索引都识别不到时才会调用模型，避免一次问题消耗多次额度。

不要把以下模型放进 `GEMINI_MODELS`：

- Embedding 模型：只适合向量检索，不会直接输出裁定回答。
- Imagen / Veo / Lyra / TTS / Live API：图像、视频、音频或实时对话模型，不适合这个后端。
- Robotics / Computer Use / Deep Research 代理类模型：接口和用途不适合当前 `generateContent` JSON 回答链路。

如果 Google AI Studio 中显示 Gemma 文字模型有免费额度，可以在确认 API model id 后追加到 `GEMINI_MODELS` 最后面。Gemma 更适合作为兜底，不建议排在 Flash 前面。

可选配置：

- `GEMINI_CARD_RESOLUTION_MODEL`：卡名解析单独使用的模型，例如 `gemini-2.5-flash-lite`。
- `GEMINI_MODEL`：只使用单个 Gemini 模型时再填；如果已经设置 `GEMINI_MODELS`，可以不填。
- `MODEL_CARD_RESOLUTION=off`：完全关闭模型卡名解析，只使用本地别名、同步资料和实时索引。
- `GEMINI_TEMPERATURE=0.1`：降低输出随机性，减少 JSON 格式异常。

部署完成后，把 `config.example.json` 复制为 `config.json`，填入后端地址：

```json
{
  "answerApiUrl": "https://你的项目.vercel.app/api/answer"
}
```

再把 `config.json` 上传到 GitHub Pages 仓库。

## 回答模式

- `confirmed`：命中 Q&A 或 FAQ 等可直接引用资料。
- `inferred`：基于效果文本和规则原则推理，不能当作官方确认裁定。
- `unknown`：资料不足，不能确定。

如果只命中卡片效果文本，后端不会把答案标记为 `confirmed`。

## 同步参数

在 `.github/workflows/sync-data.yml` 中调整：

- `SYNC_ALL_RELEASED_CARDS`：是否同步全已发售卡基础资料。
- `MAX_QA_TOTAL`：本次同步最多抓取多少条 Q&A。
- `FETCH_CONCURRENCY`：抓取并发数量。
- `CARD_INDEX_LANGUAGES`：用哪些语言的卡名索引发现卡片。

第一次部署建议先保持默认参数，确认 Actions 能稳定跑完后再提高 `MAX_QA_TOTAL`。
