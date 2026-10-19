/**
 * Track the latest turn per thread so the broker can interrupt a turn whose
 * owning client disconnects.
 *
 * The companion buffers turn notifications until `turn/start` resolves, so a
 * cancellation that arrives while the start request is pending can close the
 * client socket before the companion ever learns the turn id. The broker sees
 * the notifications (and the start response) directly, so it keeps the mapping
 * and can interrupt the turn even after the client is gone.
 */
export function createTurnTracker() {
  const turns = new Map();

  return {
    noteNotification(message) {
      const method = message?.method;
      const threadId = message?.params?.threadId;
      if (!threadId) {
        return;
      }
      if (method === "turn/started") {
        const turnId = message.params?.turn?.id;
        if (turnId) {
          turns.set(threadId, turnId);
        }
        return;
      }
      if (method === "turn/completed") {
        turns.delete(threadId);
      }
    },
    noteStreamingResult(method, params, result) {
      const threadId = params?.threadId ?? result?.reviewThreadId ?? null;
      const turnId = result?.turn?.id ?? null;
      if (threadId && turnId) {
        turns.set(threadId, turnId);
      }
    },
    targets(threadIds) {
      const out = [];
      for (const threadId of threadIds ?? []) {
        const turnId = turns.get(threadId);
        if (turnId) {
          out.push({ threadId, turnId });
        }
      }
      return out;
    },
    forget(threadIds) {
      for (const threadId of threadIds ?? []) {
        turns.delete(threadId);
      }
    }
  };
}
