# 管理认证与安全配置

## 安全边界

管理接口必须同时满足：

- 精确匹配允许的 `Origin`；
- 有效的短期 HttpOnly 会话 Cookie；
- 所有改变状态的请求携带正确 CSRF Token。

`?admin=1`、请求体中的模型名、查询参数或公共 API Cookie 都不能替代管理认证。

管理 Cookie 使用：

```text
__Host-ocg_admin_session
Path=/
HttpOnly
Secure
SameSite=None
```

之所以使用 `SameSite=None`，是因为当前静态页面部署在 GitHub Pages，API 部署在 Vercel，属于跨站请求。所有管理请求仍必须使用精确 Origin、CSRF 和 `credentials: include`。

## 部署变量

安全起始值是关闭管理实验和付费 OpenAI 调用：

```text
ADMIN_MODEL_LAB_ENABLED=false
ADMIN_OPENAI_ENABLED=false
```

仓库根目录 `.env.example` 使用的就是这组默认值。完成精确 Origin、管理员密码、持久 Redis 和服务端模型凭据配置后，管理员才可在部署环境中把两个开关都改为 `true`。

显式启用时由管理员在 Vercel 服务端环境配置，禁止写入仓库或前端：

```text
ADMIN_SESSION_PASSWORD=<高强度管理员密码>
ADMIN_ALLOWED_ORIGINS=https://coldiceh.github.io
ADMIN_MODEL_LAB_ENABLED=true
ADMIN_OPENAI_ENABLED=true
OPENAI_API_KEY=<服务端 OpenAI Project Key>
DEEPSEEK_API_KEY=<服务端 DeepSeek Key>
UPSTASH_REDIS_REST_URL=<已有 Redis REST URL>
UPSTASH_REDIS_REST_TOKEN=<已有 Redis REST Token>
```

如果以后把管理页面迁移到自有域名，应把 `ADMIN_ALLOWED_ORIGINS` 改为真实管理页面 Origin。不得使用 `*`。

可选：

```text
ADMIN_SESSION_TTL_SECONDS=900
ADMIN_LOGIN_WINDOW_SECONDS=600
ADMIN_LOGIN_MAX_ATTEMPTS=5
ADMIN_RUN_REDIS_KEY_PREFIX=admin-runs:v1
```

不要把 `ADMIN_SESSION_PASSWORD` 与额度重置口令复用。OpenAI Key 不得通过 capabilities、错误响应、Run metadata 或导出数据返回浏览器。

默认测试套件不会读取这些真实 Key，也不会调用付费模型。真实付费测试必须是管理员明确批准的手工操作；不得把打开管理界面、运行 `pnpm test` 或 CI 当作付费授权。

## 失败关闭

以下情况不得降级成未认证访问或进程内伪持久化：

- 没有配置允许 Origin；
- 没有管理员密码；
- 没有持久 Redis；
- Cookie 过期、Origin 不一致或 CSRF 无效；
- 请求选择未允许的模型、mode 或 reasoning effort；
- 上游错误响应可能包含敏感内容。
