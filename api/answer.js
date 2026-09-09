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
import { createPublicAnswerPreparationStore } from "../backend/publicAnswerPreparationStore.mjs";
import { preparePublicAnswer, finalizePublicAnswer, preparedAnswerProgress } from "../backend/publicPreparedAnswerService.mjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export function createPublicAnswerHandler({
  env = process.env,
  createStore = createPublicAnswerPreparationStore,
  prepare = preparePublicAnswer,
  finalize = finalizePublicAnswer,
} = {}) {
return async function handler(request, response) {
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
    if (payload.action === "prepare" || payload.action === "finalize") {
      await answerInSeparateRequest({ request, response, requestAbort, requestChannel,
        payload, env, store: createStore({ env }), prepare, finalize });
      return;
    }
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
};
}

export default createPublicAnswerHandler();

async function answerInSeparateRequest({ request, response, requestAbort, requestChannel,
  payload, env, store, prepare, finalize }) {
  // Claim is an atomic one-way state transition before any final generation.
  // Unknown claim outcomes are never retried or treated as authorization.
  const claim = payload.action === "finalize" ? await store.claim(payload.preparationId) : null;
  const streaming = wantsPublicAnswerProgress(request, requestChannel);
  if (streaming) beginPublicAnswerEventStream(response);
  const progress = createPublicAnswerProgress({
    emit: streaming ? (type, data) => sendPublicAnswerEvent(response, type, data) : () => {},
    ...(claim?.state === "claimed" ? {
      initialProgress: preparedAnswerProgress(claim.preparation), initialStageId: "generate_ruling",
    } : {}),
  });
  let timer;
  try {
    let result;
    let measured;
    if (claim?.state === "completed") {
      result = claim.result;
      measured = result.progress;
    } else {
      progress.start();
      timer = setInterval(() => progress.tick(), 1000);
      timer.unref?.();
      result = payload.action === "prepare"
        ? await prepare({ payload, env, signal: requestAbort.signal, progress, store })
        : await finalize({ preparation: claim.preparation, env, signal: requestAbort.signal, progress });
      measured = result.progress || progress.complete();
      if (claim?.state === "claimed") {
        // A storage acknowledgement failure must not discard a real answer.
        // The record stays running/completed, preventing duplicate generation.
        await store.complete(payload.preparationId, { ...result, progress: measured }).catch(() => null);
      }
    }
    if (requestAbort.signal.aborted) return;
    if (result.preparationId) {
      if (streaming) {
        sendPublicAnswerEvent(response, "prepared", { preparationId: result.preparationId, progress: measured });
        sendPublicAnswerEvent(response, "end", measured);
        response.end();
      } else {
        response.status(200).json({ status: "evidence_prepared", preparationId: result.preparationId, progress: measured });
      }
      return;
    }
    const answer = presentPublicAnswer(result.answer, { channel: requestChannel, env });
    if (streaming) {
      sendPublicAnswerEvent(response, "answer", { answer, progress: measured });
      sendPublicAnswerEvent(response, "end", measured);
      response.end();
    } else {
      response.status(200).json(answer);
    }
    if (claim?.state !== "completed") {
      await persistPublicAnswerLatency({ latency: result.latency, env }).catch(() => null);
    }
  } catch (error) {
    if (claim?.state === "claimed") await store.fail(payload.preparationId).catch(() => null);
    if (requestAbort.signal.aborted) return;
    if (!streaming) throw error;
    const stageId = progress.activeStageId;
    const measured = progress.fail();
    const httpError = publicAnswerHttpError(error);
    sendPublicAnswerEvent(response, "error", { ...httpError.payload, statusCode: httpError.statusCode,
      stageId, serverElapsedMs: measured.totalMs });
    sendPublicAnswerEvent(response, "end", measured);
    response.end();
  } finally {
    clearInterval(timer);
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
