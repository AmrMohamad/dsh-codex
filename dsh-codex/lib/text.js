/**
 * Small text helpers shared by the plugin layer. Pure functions, no I/O.
 */

/** Normalize companion output for model consumption (LF endings, no trailing spaces). */
export function cleanOutput(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * Collapse whitespace and cut to `limit` characters with an ellipsis. Never
 * splits a UTF-16 surrogate pair (a lone surrogate is invalid in JSON-RPC
 * payloads; see upstream openai/codex-plugin-cc#793).
 */
export function shorten(text, limit = 72) {
  const value = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (value.length <= limit) {
    return value;
  }
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

/** Keep the last `limit` characters, marking the cut. */
export function tail(text, limit = 4000) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`;
}
