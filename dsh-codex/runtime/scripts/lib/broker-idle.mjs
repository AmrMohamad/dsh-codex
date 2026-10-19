/**
 * Decide whether a shared Codex broker may be reaped for inactivity.
 *
 * A broker is in use while a request or streaming turn owns it, and also while
 * a client connected for a turn is still open. Only a broker with no active
 * ownership and no recent activity may shut down.
 */
export function shouldReapBroker(input) {
  const idleTimeoutMs = Number(input.idleTimeoutMs);
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return false;
  }
  if (input.activeRequest || input.activeStream) {
    return false;
  }
  const lastActivityAt = Number(input.lastActivityAt);
  if (!Number.isFinite(lastActivityAt)) {
    return false;
  }
  return Number(input.now) - lastActivityAt >= idleTimeoutMs;
}
