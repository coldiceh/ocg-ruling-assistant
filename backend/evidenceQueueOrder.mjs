// Shared deterministic ordering; no data loading, model calls or CLI imports.
export function completeDenseQueue(candidates, scores) {
  if (!Array.isArray(scores) || scores.length !== candidates.length
      || scores.some((score) => !Number.isFinite(score))) {
    throw new Error("calibration_dense_scores_invalid");
  }
  return Object.freeze(candidates.map((candidate, index) => ({
    candidate,
    score: scores[index],
  })).sort((left, right) => (
    right.score - left.score
      || String(left.candidate.binding).localeCompare(String(right.candidate.binding), "en")
  )).map((row) => row.candidate));
}

export function roundRobinLexicalDense(lexicalQueue, denseQueue, candidateLimit) {
  if (candidateLimit !== undefined
      && (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1)) {
    throw new TypeError("calibration_surface_candidate_limit_invalid");
  }
  if (lexicalQueue.length !== denseQueue.length) {
    throw new Error("calibration_surface_queue_length_mismatch");
  }
  const positions = [0, 0];
  const queues = [lexicalQueue, denseQueue];
  const selected = new Set();
  const ordered = [];
  while (true) {
    let added = false;
    for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
      const queue = queues[queueIndex];
      while (positions[queueIndex] < queue.length) {
        const candidate = queue[positions[queueIndex]];
        positions[queueIndex] += 1;
        if (selected.has(candidate.binding)) continue;
        selected.add(candidate.binding);
        ordered.push(candidate);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  if (ordered.length !== lexicalQueue.length || selected.size !== lexicalQueue.length) {
    throw new Error("calibration_surface_total_order_incomplete");
  }
  return Object.freeze(candidateLimit === undefined ? ordered : ordered.slice(0, candidateLimit));
}
