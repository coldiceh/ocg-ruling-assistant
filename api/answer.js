import {
  answerPublicRulingQuestion,
  createPublicAnswerAbortContext,
  declaredRequestBodyBytes,
  getPublicAnswerModelInfo,
  parsePublicAnswerPayload,
  persistPublicAnswerLatency,
  publicAnswerHttpError,
} from "../backend/publicAnswerService.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method === "GET") {
    response.status(200).json(await getPublicAnswerModelInfo({ env: process.env }));
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const requestAbort = createPublicAnswerAbortContext(request, response);
  try {
    const payload = parsePublicAnswerPayload(request.body, {
      declaredBytes: declaredRequestBodyBytes(request),
    });
    const result = await answerPublicRulingQuestion({
      payload,
      env: process.env,
      signal: requestAbort.signal,
    });
    response.status(200).json(result.answer);
    // The answer is already on the wire. This best-effort write cannot replace
    // or delay the successful response observed by the client.
    await persistPublicAnswerLatency({
      latency: result.latency,
      env: process.env,
    }).catch(() => null);
  } catch (error) {
    if (requestAbort.signal.aborted) return;
    const httpError = publicAnswerHttpError(error);
    response.status(httpError.statusCode).json(httpError.payload);
  } finally {
    requestAbort.cleanup();
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
