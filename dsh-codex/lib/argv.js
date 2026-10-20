/**
 * Companion argument builders. Each returns the argv that follows
 * `node codex-companion.mjs`, always pins `--cwd`, and passes values as
 * separate tokens (never `--key=value`). Prompt text travels through files
 * (`--prompt-file`, `--focus-file`), never through argv.
 */

function reviewCommandArgv(command, options) {
  const argv = [command, "--cwd", options.cwd];
  if (options.base) argv.push("--base", String(options.base));
  if (options.scope) argv.push("--scope", String(options.scope));
  if (options.model) argv.push("--model", String(options.model));
  if (options.jobId) argv.push("--job-id", String(options.jobId));
  return argv;
}

export function reviewArgv(options) {
  return reviewCommandArgv("review", options);
}

export function adversarialReviewArgv(options) {
  const argv = reviewCommandArgv("adversarial-review", options);
  if (options.focusFile) argv.push("--focus-file", options.focusFile);
  return argv;
}

export function taskArgv(options) {
  const argv = ["task", "--cwd", options.cwd];
  if (options.promptFile) argv.push("--prompt-file", options.promptFile);
  if (options.model) argv.push("--model", String(options.model));
  if (options.effort) argv.push("--effort", String(options.effort));
  if (options.write) argv.push("--write");
  if (options.resumeLast) argv.push("--resume-last");
  if (options.jobId) argv.push("--job-id", String(options.jobId));
  return argv;
}

export function setupArgv(options = {}) {
  return ["setup", "--cwd", options.cwd];
}

export function statusArgv(options = {}) {
  const argv = ["status", "--cwd", options.cwd];
  if (options.jobId) argv.push(String(options.jobId));
  if (options.all) argv.push("--all");
  if (options.wait) argv.push("--wait");
  if (options.timeoutMs) argv.push("--timeout-ms", String(options.timeoutMs));
  return argv;
}

export function resultArgv(options = {}) {
  const argv = ["result", "--cwd", options.cwd];
  if (options.jobId) argv.push(String(options.jobId));
  return argv;
}

export function cancelArgv(options = {}) {
  const argv = ["cancel", "--cwd", options.cwd];
  if (options.jobId) argv.push(String(options.jobId));
  return argv;
}
