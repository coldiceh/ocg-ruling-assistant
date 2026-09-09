import { createHash, randomBytes } from "node:crypto";

// Only server-owned continuations live here. The browser receives a random
// capability, never the prompt/evidence or provider credentials.
export const PUBLIC_PREPARATION_TTL_SECONDS = 15 * 60;
const PREFIX = "public-answer-preparation:v1:";
const CLAIM = `
local raw = redis.call("GET", KEYS[1])
if not raw then return {"missing"} end
local record = cjson.decode(raw)
if record.deployment ~= ARGV[1] then return {"deployment_changed"} end
if record.state == "completed" then return {"completed", record.result} end
if record.state ~= "ready" then return {record.state} end
record.state = "running"
redis.call("SET", KEYS[1], cjson.encode(record), "KEEPTTL")
return {"claimed", record.preparation}
`.trim();
const FINISH = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "missing" end
local record = cjson.decode(raw)
if record.deployment ~= ARGV[1] or record.state ~= "running" then return "conflict" end
record.state = ARGV[2]
record.result = ARGV[3]
redis.call("SET", KEYS[1], cjson.encode(record), "KEEPTTL")
return "saved"
`.trim();

export function isPublicPreparationId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function createPublicAnswerPreparationStore({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || env.REDIS_REST_API_URL || "").trim();
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || env.REDIS_REST_API_TOKEN || "").trim();
  if (!url || !token) throw preparationError("资料暂存服务尚未配置", "answer_preparation_storage_unavailable", 503);
  const deployment = String(env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL || env.VERCEL_GIT_COMMIT_SHA || "local");
  const key = (id) => {
    if (!isPublicPreparationId(id)) throw preparationError("无效的资料准备凭证", "invalid_preparation_id", 400);
    return PREFIX + createHash("sha256").update(id).digest("hex");
  };
  async function command(args) {
    // No automatic transport retry: an acknowledged claim is required before
    // a model is called. A lost acknowledgement never makes the record ready.
    try {
      const response = await fetchImpl(url, {
        method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("storage_http_error");
      const body = await response.json();
      if (body.error || !Object.hasOwn(body, "result")) throw new Error("storage_response_error");
      return body.result;
    } catch {
      throw preparationError("资料暂存服务暂时不可用，请稍后再试", "answer_preparation_storage_unavailable", 503);
    }
  }
  return {
    async create(preparation) {
      const id = randomBytes(32).toString("hex");
      // Nested JSON is stored as an opaque string. Redis Lua must not roundtrip
      // evidence arrays, nulls or text through cjson before final generation.
      const record = JSON.stringify({ state: "ready", deployment, preparation: JSON.stringify(preparation) });
      const result = await command(["SET", key(id), record, "EX", PUBLIC_PREPARATION_TTL_SECONDS, "NX"]);
      if (result !== "OK") throw preparationError("资料保存未确认", "answer_preparation_save_unconfirmed", 503);
      return id;
    },
    async claim(id) {
      const result = await command(["EVAL", CLAIM, 1, key(id), deployment]);
      if (!Array.isArray(result)) throw preparationError("资料状态无法确认", "answer_preparation_state_unknown", 503);
      if (result[0] === "claimed") return { state: "claimed", preparation: JSON.parse(result[1]) };
      if (result[0] === "completed") return { state: "completed", result: JSON.parse(result[1]) };
      const messages = {
        missing: ["资料准备结果已过期或不存在，请重新提交问题", "answer_preparation_expired", 410],
        deployment_changed: ["服务已更新，请重新提交问题", "answer_preparation_deployment_changed", 409],
        running: ["本次作答已启动，执行状态尚未确认；未重复调用模型", "answer_preparation_in_progress", 409],
        failed: ["本次作答未能完成；未重复调用模型", "answer_preparation_failed", 409],
      };
      throw preparationError(...(messages[result[0]] || ["资料状态无法确认", "answer_preparation_state_unknown", 503]));
    },
    async complete(id, result) {
      const saved = await command(["EVAL", FINISH, 1, key(id), deployment, "completed", JSON.stringify(result)]);
      if (saved !== "saved") throw preparationError("回答保存未确认", "answer_preparation_save_unconfirmed", 503);
    },
    async fail(id) {
      await command(["EVAL", FINISH, 1, key(id), deployment, "failed", "null"]);
    },
  };
}

export function preparationError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
