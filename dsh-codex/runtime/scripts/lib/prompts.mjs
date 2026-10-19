import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** runtime/ — the directory that holds prompts/ and schemas/. */
const RUNTIME_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}

/**
 * Wrap a delegated task (or a follow-up on a resumed thread) in the task
 * envelope: the caller's text verbatim, the access rules for this run, the
 * working rules, and the handoff-report contract the Harness agent relies on.
 * See prompts/task.md and docs/PROMPTS.md.
 */
export function buildTaskPrompt({ task, write = false }, rootDir = RUNTIME_ROOT) {
  const access = loadPromptTemplate(rootDir, write ? "task-write" : "task-read-only").trim();
  return interpolateTemplate(loadPromptTemplate(rootDir, "task"), {
    TASK: String(task ?? "").trim(),
    ACCESS_RULES: access
  });
}

/** Build the adversarial-review prompt from collected repository context. */
export function buildAdversarialReviewPrompt(context, focusText, rootDir = RUNTIME_ROOT) {
  return interpolateTemplate(loadPromptTemplate(rootDir, "adversarial-review"), {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}
