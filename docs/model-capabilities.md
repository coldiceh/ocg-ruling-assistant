# 管理实验模型能力表

| Provider | 模型 | 用途 | 可作最终裁定 | 后台查询/取消 | 结构化输出 |
| --- | --- | --- | --- | --- | --- |
| DeepSeek | V4 Flash / Pro | 证据准备 | 否 | 否 | JSON object |
| OpenAI | GPT-5.6 Sol | 最终裁定 | 是 | 是 | strict JSON Schema |
| OpenAI | GPT-5.6 Terra | 最终裁定 | 是 | 是 | strict JSON Schema |
| OpenAI | GPT-5.6 Luna | 最终裁定 | 是 | 是 | strict JSON Schema |
| OpenAI | GPT-5.6 alias | 最终裁定 | 是 | 是 | strict JSON Schema |

能力表由服务端返回，`available` 只表示相应服务端密钥和开关是否存在，不返回密钥内容。

固定策略：

- DeepSeek 的 `canMakeFinalRuling` 为 `false`。
- DeepSeek 的 `canDecideEscalation` 为 `false`。
- GPT-5.6 的 `canMakeFinalRuling` 为 `true`。
- 公共问答 Provider 仍为 DeepSeek。
- 管理实验最终裁定 Provider 固定为 OpenAI。

客户端选择只是请求，最终有效模型、reasoning effort 和 mode 由服务端重新验证。
