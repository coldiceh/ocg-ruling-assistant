import {
  answerPublicRulingQuestion,
  createPublicAnswerAbortContext,
  declaredRequestBodyBytes,
  getPublicAnswerModelInfo,
  parsePublicAnswerPayload,
  persistPublicAnswerLatency,
  publicAnswerHttpError,
} from "../backend/publicAnswerService.mjs";
import {
  classifyPublicRequestChannel,
  presentPublicAnswer,
} from "../backend/publicAnswerPresentation.mjs";
import {
  beginPublicAnswerEventStream,
  createPublicAnswerProgress,
  sendPublicAnswerEvent,
  wantsPublicAnswerProgress,
} from "../backend/publicAnswerProgress.mjs";

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
    const requestChannel = classifyPublicRequestChannel(request.body);
    const payload = parsePublicAnswerPayload(request.body, {
      declaredBytes: declaredRequestBodyBytes(request),
    });
    if (wantsPublicAnswerProgress(request, requestChannel)) {
      await answerWithProgressStream({
        request,
        response,
        requestAbort,
        requestChannel,
        payload,
      });
      return;
    }
    const result = await answerPublicRulingQuestion({
      payload,
      env: process.env,
      signal: requestAbort.signal,
    });
    response.status(200).json(presentPublicAnswer(result.answer, {
      channel: requestChannel,
      env: process.env,
    }));
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

async function answerWithProgressStream({
  response,
  requestAbort,
  requestChannel,
  payload,
}) {
  beginPublicAnswerEventStream(response);
  const progress = createPublicAnswerProgress({
    emit: (type, data) => sendPublicAnswerEvent(response, type, data),
  });
  progress.start();
  const tickTimer = setInterval(() => progress.tick(), 1_000);
  tickTimer.unref?.();
  try {
    const result = await answerPublicRulingQuestion({
      payload,
      env: process.env,
      signal: requestAbort.signal,
      progress,
    });
    const measuredProgress = progress.complete();
    const answer = presentPublicAnswer(result.answer, {
      channel: requestChannel,
      env: process.env,
    });
    sendPublicAnswerEvent(response, "answer", { answer, progress: measuredProgress });
    sendPublicAnswerEvent(response, "end", measuredProgress);
    response.end();
    await persistPublicAnswerLatency({
      latency: result.latency,
      env: process.env,
    }).catch(() => null);
  } catch (error) {
    if (requestAbort.signal.aborted) return;
    const activeStageId = progress.activeStageId;
    const measuredProgress = progress.fail();
    const httpError = publicAnswerHttpError(error);
    sendPublicAnswerEvent(response, "error", {
      ...httpError.payload,
      statusCode: httpError.statusCode,
      stageId: activeStageId,
      serverElapsedMs: measuredProgress.totalMs,
    });
    sendPublicAnswerEvent(response, "end", measuredProgress);
    response.end();
  } finally {
    clearInterval(tickTimer);
  }
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
