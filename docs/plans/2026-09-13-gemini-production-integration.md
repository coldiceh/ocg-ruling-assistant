# Gemini 规则与 QA 生产接入

决策问题：新方法能否在实际网页 prepare/download/finalize 路径保留充分且完整的所选原文；通过后直接发布。不追加最终裁定正确率基准作为前置条件。

实现：查卡后，Google Gemini 3.8 Flash low 阅读完整社区规则缓存和四条预取 QA/FAQ，可调用 search_qa 补查；submit_evidence 返回规则段落和完整 QA 引用。本服务解析引用并从绑定版本恢复 canonical 正文，生成唯一的原始 prompt，直接用于 prepare 下载和后续最终模型。没有程序语义充分性判断，社区规则仍是 community_reference/official:false。

QA 以正式 qa-index.json 的完整记录为主，按稳定 ID 补入 rulings.json 中独有 QA/FAQ。当前 27,715 条，含 11,587 QA 和 16,128 FAQ。最初只读 rulings 导致遗漏 11,339 个 QA，已在资产构建输入处修复，未改检索排序或添加个案特判。QA revision 绑定两份来源字节，资料与索引同版发布；每日同步时间保持北京时间03:00。新请求使用发布版本，进行中的请求保留已有快照；Google 规则缓存键不含 QA revision。

规则缓存固定180秒，按需建立，不自动续时。已有 Redis 仅共享公共规则缓存名称/到期时间/合同hash，并用短期锁避免多个实例同时建同一缓存。Google原生工具Content/Part及thoughtSignature跨轮保留。检索最多三轮；到限未提交则返回准备失败，不伪装充分，也不调用最终模型。超出36000字符时返回实际容量让模型重新选择完整条目，不截断原文。

费用在已有 cloud budget 内预留/结算：普通输入0.75、缓存输入0.075、输出含思考3.75美元/百万token；缓存完整TTL存储0.50美元/百万token/小时。缓存创建输入实账未确认，记录保守理论provision并明确标注unknown。费用不是B.AI账单。生产密钥使用GEMINI_RULE_QA_API_KEY；开关GEMINI_RULE_QA_ENABLED，只配置Production。

复用原十题父审结果（十题皆含必要完整QA；公开QA改写样本，不代表新题召回保证）。本轮生产源码和最新资料补验Q03/Q05：最初缺源两题各三轮未提交，保留失败与费用；修复后两题均第一轮提交，实际完整prompt分别5062/4771字符，父直接读正文确认必要问答分支保留。Q03原冲突的一般规则不再入包；Q05仍有不适用的离场背景规则，直接QA明确说明只有本体成为装备、素材送墓，背景冗余未作为必要依据。本轮新增模型不作最终裁定。

修复后两题provider时间5.862秒（含首次本地加载/建缓存）和1.306秒（复用）；不等同网页端到端。两轮补验合计保守理论计账0.83805875美元，包含失败、两个缓存创建输入provision和完整TTL；缓存已删除。在线发布验证另记。

机械验证覆盖：完整canonical字符串、原authority、工具签名往返、版本绑定、完整当前来源ID集合、短TTL复用、预算含思考token、原prompt贯穿prepare/download/finalize、现有发布流程。正式源/运行时/cloud索引版本检查通过。相关新旧测试通过；测试不替代父对实际正文的充分性判断。

官方接口依据：[缓存API](https://ai.google.dev/api/caching)、[函数调用](https://ai.google.dev/gemini-api/docs/function-calling)。
