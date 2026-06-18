# 游戏王OCG文本规则相关疑问助手

一个面向游戏王 OCG 对局裁定的问答工具。目标不是替代官方数据库，而是把自然语言场面描述拆成可核对的问题，并优先给出带出处、带更新时间、可复查的裁定依据。

## 当前状态

这是早期 MVP。

- 可直接部署到 GitHub Pages。
- 前端无构建步骤，打开 `index.html` 即可使用。
- 已加入可部署后端 `POST /api/answer`，用于全卡资料检索和可选模型回答。
- `data/` 目录保存静态资料快照，页面会显示同步时间和过期状态。
- GitHub Actions 可以定时从结构化资料源同步已发售卡片、FAQ 与 Q&A 数据。
- 没有可追溯资料时，系统只给“待确认/需补信息”，不会硬编结论。
- 当前静态版不会把无关卡片文本当作裁定答案；若只命中效果文本，会提示需要 Q&A 或人工确认。

## 正确性原则

1. 官方数据库和已确认事务局裁定优先。
2. 同步快照超过 `freshnessDays` 后，答案自动降级为“需复核”。
3. 没有来源链接、官方 Q&A 或可信记录的条目，不能标记为确定裁定。
4. 用户可以输入俗称或民间译名；系统先尝试解析，解析不到或条件不足时再追问关键线索。
5. 裁定变更时，保留旧快照和更新时间，让答案能被复查。

## 本地使用

直接打开 `index.html`。

由于浏览器对本地文件读取 JSON 有限制，双击打开时可能只使用内置保守模板；部署到 GitHub Pages 后会正常读取 `data/*.json`。

如果要在本地完整预览，可以运行：

```bash
node scripts/serve.mjs
```

然后打开 `http://127.0.0.1:4173/`。

## 自动同步

仓库包含两个工作流：

- `.github/workflows/sync-data.yml`：每天定时运行 `scripts/sync-ygoresources.mjs`，生成 `data/cards.json`、`data/cards-lite.json`、`data/rulings.json` 和 `data/snapshot-meta.json`。
- `.github/workflows/deploy-pages.yml`：把静态站部署到 GitHub Pages。

同步脚本当前使用 YGOResources 的结构化数据作为可机器读取的数据源，同时在页面中保留官方数据库作为最终权威来源。后续如果官方数据库提供稳定 API，应优先接入官方 API。

同步参数可在工作流里调整：

- `SYNC_ALL_RELEASED_CARDS=true`：默认同步已发售卡基础资料。
- `MAX_QA_TOTAL=3000`：限制每次同步的 Q&A 总量；跑得稳定后可以调大。
- `FETCH_CONCURRENCY=8`：限制并发抓取数量。

## 后端回答接口

本项目现在包含一个最小后端：

- `backend/server.mjs`：本地 Node 服务。
- `api/answer.js`：Vercel Serverless Function 入口。
- `backend/formalQuery.mjs`：`FormalRulingQuery` schema、校验、归一化和子问题拆分。
- `backend/engine.mjs`：卡名识别、按形式化子问题检索证据、规则匹配和结论降级。
- `backend/openai.mjs`：只负责把自然语言解析成形式化 JSON，以及辅助解析卡名；模型不生成裁定答案。

本地运行后端需要安装 Node.js 20 或更新版本；部署到 Vercel 时会自动使用项目里的 Node 配置。

本地运行后端：

```bash
npm run dev:backend
```

请求接口：

```http
POST http://localhost:8787/api/answer
Content-Type: application/json

{
  "question": "输入规则疑问"
}
```

GitHub Pages 前端无法保存 API key，所以需要把后端单独部署到 Vercel、Render、Cloudflare Worker 或自己的服务器。部署后复制 `config.example.json` 为 `config.json`，填入后端地址：

```json
{
  "answerApiUrl": "https://你的后端域名/api/answer"
}
```

使用 Gemini 时，在后端部署平台设置：

```text
MODEL_PROVIDER=gemini
GEMINI_API_KEY=你的 Gemini API key
GEMINI_MODELS=gemini-2.5-flash,gemini-3-flash,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite
GEMINI_CARD_RESOLUTION_MODELS=gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash
GEMINI_MAX_OUTPUT_TOKENS=2600
GEMINI_CARD_RESOLUTION_TOKENS=1200
GEMINI_PARSER_MODELS=gemini-2.5-flash
GEMINI_PARSER_TOKENS=2400
GEMINI_TEMPERATURE=0.1
ALLOWED_ORIGIN=https://coldiceh.github.io
```

如果设置了 `GEMINI_MODELS`，后端会按顺序尝试这些文字模型。前一个模型遇到免费额度耗尽、限速或输出格式异常时，会自动换下一个。图片、视频、语音、Embedding、Live API 和代理类模型不适合当前裁定问答链路。

## GitHub Pages 部署

1. 新建 GitHub 仓库，把本项目推到 `main` 分支。
2. 在仓库 Settings -> Pages 中选择 GitHub Actions。
3. 打开 Actions，手动运行一次 `Sync ruling data`。
4. 再运行或等待 `Deploy GitHub Pages`。

如果本机没有 Git，但已经安装并登录 GitHub CLI，也可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/publish-github.ps1 -Repo coldiceh/ocg-ruling-assistant
```

更推荐安装 Git for Windows 后使用标准 Git 推送：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-git.ps1
powershell -ExecutionPolicy Bypass -File scripts/publish-git.ps1
```

如果 GitHub CLI 登录失效，先重新登录并让 Git 使用它的凭据：

```powershell
D:\githubcli\gh.exe auth login -h github.com -s repo,workflow -w
D:\githubcli\gh.exe auth setup-git
```

## 资料维护

- 重点俗称和人工别名仍可写在 `data/tracked-cards.json`。
- 适合长期共用的裁定，应整理成带来源的 JSON 条目后提交 PR。
- 模型只能生成形式化查询，不能生成裁定结论；没有匹配当前子问题类型的 Q&A/FAQ 时，不能标记为已确认。

## 路线图

- 扩大 Q&A 同步范围，逐步接近全量。
- 接入更多官方 Q&A 快照和变更检测。
- 继续完善中文卡名、俗称、日文名、英文名的统一索引。
- 加入“场面结构化输入”：双方场上、墓地、连锁、阶段、控制者。
- 增加裁定变更提醒页，专门展示最近变化。
- 持续扩充后端的形式化规则匹配；模型始终只做问题解析，不参与裁定结论。

详见 [全卡裁定问答方案](docs/full-ruling-engine.md)。
后端部署步骤见 [后端部署](docs/backend-deployment.md)。

## 免责声明

本项目不是 Konami 官方产品。对局裁定如有争议，应以官方数据库、赛事主办方和裁判最终判断为准。
