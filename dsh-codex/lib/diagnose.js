/**
 * Turn known Codex failure text into one actionable next step for the agent.
 *
 * Raw Codex errors ("401", "refresh_token_reused", "usage limit") do not say
 * what to do, and an agent that does not understand them tends to retry in a
 * loop. Each rule matches a failure family seen in the field (see
 * docs/RESEARCH.md) and returns a hint that is appended to the error, never a
 * replacement for it.
 */

const RULES = [
  {
    // Account usage/rate limits. Retrying immediately cannot succeed
    // (openai/codex#47728 shows drivers relaunching in a tight loop).
    pattern: /usage[ _-]?limit|rate[ _-]?limit|too many requests|\b429\b|quota|out of credits/i,
    hint:
      "Codex hit an account usage or rate limit. Do not retry now; tell the user, and run Codex again " +
      "after the limit resets."
  },
  {
    // Single-use refresh token consumed by another Codex process
    // (openai/codex-plugin-cc#789) or an expired/revoked login.
    pattern: /refresh[ _-]?token|\b401\b|unauthorized|not logged in|not authenticated|login (?:required|expired)/i,
    hint:
      "Codex authentication failed. Ask the user to run `codex login` in a terminal, then call " +
      "codex_setup with force:true. Idle Codex brokers holding stale tokens exit on their own."
  },
  {
    pattern: /Codex CLI was not found|codex: (?:command )?not found|spawn codex ENOENT/i,
    hint: "The Codex CLI is not installed or not on the Harness PATH. Run codex_setup for details."
  }
];

/** @returns {string | null} a one-line hint for the failure, or null when unknown */
export function diagnoseCodexFailure(text) {
  const value = String(text ?? "");
  return RULES.find((rule) => rule.pattern.test(value))?.hint ?? null;
}

/**
 * Append the diagnosis (when there is one) as a final `Hint:` line. `evidence`
 * is the text to diagnose when it differs from the message shown.
 */
export function withFailureHint(text, evidence = text) {
  if (/\nHint: /.test(text)) {
    return text; // Already diagnosed upstream in the same failure path.
  }
  const hint = diagnoseCodexFailure(evidence);
  return hint ? `${text}\nHint: ${hint}` : text;
}
