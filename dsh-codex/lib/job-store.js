/**
 * Read-only access to the companion's durable job records
 * (`<dataDir>/state/<workspace>/jobs/<jobId>.json`) and their rendering.
 *
 * Reading records needs no Codex install and no child process, so status and
 * result lookups by id stay fast and keep working when the CLI is broken.
 * The vendored runtime owns writing these files (runtime/scripts/lib/state.mjs).
 */
import fs from "node:fs";
import path from "node:path";

import { cleanOutput } from "./text.js";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_OBJECT_RESULT_CHARS = 8000;

export function isTerminalStoredJob(job) {
  return Boolean(job) && TERMINAL_JOB_STATUSES.has(String(job.status ?? ""));
}

function workspaceJobDirs(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  try {
    return fs
      .readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(stateRoot, entry.name, "jobs"));
  } catch {
    return [];
  }
}

/**
 * Find a durable job record by id across every workspace. Used when a lookup
 * comes from a different working directory than the run used.
 *
 * @returns {Record<string, any> | null}
 */
export function findStoredCodexJob(dataDir, jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId) || jobId.includes("..")) {
    return null;
  }
  for (const jobsDir of workspaceJobDirs(dataDir)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
    } catch {
      // Not in this workspace; keep looking.
    }
  }
  return null;
}

/**
 * List durable job records across every workspace, newest first.
 *
 * @param {string} dataDir
 * @param {{ sessionId?: string | null; limit?: number; terminalOnly?: boolean }} [options]
 * @returns {Record<string, any>[]}
 */
export function listStoredCodexJobs(dataDir, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const jobs = [];
  for (const jobsDir of workspaceJobDirs(dataDir)) {
    let files;
    try {
      files = fs.readdirSync(jobsDir).filter((file) => file.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      let job;
      try {
        job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
      } catch {
        continue; // Unreadable or partially written.
      }
      if (!job || typeof job.id !== "string" || job.id !== file.slice(0, -5)) {
        continue;
      }
      if (options.sessionId && job.sessionId !== options.sessionId) {
        continue;
      }
      if (options.terminalOnly && !isTerminalStoredJob(job)) {
        continue;
      }
      jobs.push(job);
    }
  }
  const timeOf = (job) => String(job.updatedAt ?? job.completedAt ?? job.createdAt ?? "");
  jobs.sort((left, right) => timeOf(right).localeCompare(timeOf(left)));
  return jobs.slice(0, limit);
}

function storedJobBody(job) {
  if (typeof job?.rendered === "string" && job.rendered.trim()) {
    return cleanOutput(job.rendered);
  }
  if (typeof job?.result === "string" && job.result.trim()) {
    return cleanOutput(job.result);
  }
  if (job?.result && typeof job.result === "object") {
    try {
      const json = JSON.stringify(job.result, null, 2);
      return json.length > MAX_OBJECT_RESULT_CHARS ? `${json.slice(0, MAX_OBJECT_RESULT_CHARS)}\n…(truncated)` : json;
    } catch {
      return "";
    }
  }
  return cleanOutput(job?.summary || "");
}

/**
 * Render one durable record for the model/user. Only completed jobs render
 * their body; failed/cancelled/running jobs render summary and error, never a
 * stale partial body.
 */
export function renderStoredCodexJob(job) {
  const status = String(job?.status ?? "");
  const lines = [];
  if (status === "completed") {
    const body = storedJobBody(job);
    if (body) {
      lines.push(body);
    }
  } else {
    const summary = cleanOutput(job?.summary || "");
    if (summary) {
      lines.push(summary);
    }
    const error = cleanOutput(job?.errorMessage || job?.detail || "");
    if (error) {
      lines.push("", `Error: ${error}`);
    }
  }
  lines.push("", `Status: ${status || "unknown"}`);
  if (job?.id) {
    lines.push(`Codex job: ${job.id}`);
  }
  if (job?.threadId) {
    lines.push(`Codex session ID: ${job.threadId}`, `Resume in Codex: codex resume ${job.threadId}`);
  }
  return lines.join("\n").trim() || "(no stored Codex output)";
}

/** Render a compact multi-job list. */
export function renderStoredCodexJobList(jobs, options = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return "No Codex job records found.";
  }
  const lines = [options.title ?? "Codex jobs for this session:", ""];
  for (const job of jobs) {
    const summary = cleanOutput(job.summary || job.rendered || "").split("\n")[0].slice(0, 96);
    lines.push(`- ${job.id} [${job.kind ?? "job"}] ${job.status ?? "unknown"}${summary ? ` — ${summary}` : ""}`);
  }
  lines.push("", "Read one with codex_result <job id>.");
  return lines.join("\n");
}
