/**
 * High-level Codex operations shared by model-facing tools and human commands.
 *
 * Responsibilities: resolve the session working directory, decide foreground vs
 * background, keep job identity/workspace bookkeeping, and return text that is
 * accurate about what actually happened (status, continuity ids, cancellation
 * outcome) without redundant child processes.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  adversarialReviewArgv,
  cancelArgv,
  cleanOutput,
  expandHome,
  findStoredCodexJob,
  isTerminalStoredJob,
  listStoredCodexJobs,
  removePromptFile,
  renderStoredCodexJob,
  renderStoredCodexJobList,
  resultArgv,
  reviewArgv,
  setupArgv,
  statusArgv,
  taskArgv,
  writePromptFile
} from "./runtime.js";
import { getJobs, runCodexForeground, startCodexJob } from "./jobs.js";

const MAX_TASK_SUMMARY = 72;
const SETUP_CACHE_TTL_MS = 30_000;

function shorten(text, limit = MAX_TASK_SUMMARY) {
  const value = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function assertOk(operation, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.code !== 0) {
    const detail = cleanOutput(result.stdout) || cleanOutput(result.stderr);
    throw new Error(
      `Codex ${operation} failed (exit ${result.code ?? "unknown"}).${detail ? `\n${detail}` : ""}`
    );
  }
}

function isLiveStatus(status) {
  return status === "running" || status === "stopping" || status === "queued";
}

export function createOperations({ ctx, runner, config = {} }) {
  const writeApprovalMode = ["ask", "allow", "deny"].includes(config?.writeApproval)
    ? config.writeApproval
    : "ask";
  /** Background Harness job id -> its originating workspace (in-memory, live jobs only). */
  const backgroundJobs = new Map();
  /** cwd -> { at, text } for repeated readiness checks. */
  const setupCache = new Map();

  function sessionDefaultDirectory(exec) {
    try {
      const session = exec?.agent?.session;
      if (session && ctx.workingDirectory) {
        return ctx.workingDirectory.get(session);
      }
    } catch {
      // Fall through to the default directory.
    }
    try {
      return ctx.workingDirectory?.defaultDirectory ?? process.cwd();
    } catch {
      return process.cwd();
    }
  }

  function resolveCwd(exec, requested) {
    const base = path.resolve(sessionDefaultDirectory(exec));
    let candidate;
    if (typeof requested === "string" && requested.trim()) {
      const expanded = expandHome(requested.trim());
      // Relative paths are documented to resolve against the session directory,
      // not against the Harness Host process's own working directory.
      candidate = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
    } else {
      candidate = base;
    }
    const resolved = path.resolve(candidate);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Working directory does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${resolved}`);
    }
    return resolved;
  }

  function sessionIdOf(exec) {
    return exec?.agent?.id ?? null;
  }

  function toolCallOf(exec) {
    if (!exec?.callId) {
      return undefined;
    }
    return { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId };
  }

  function dataDir() {
    return runner.dataDir();
  }

  /** Continuity metadata makes follow-up calls (resume_last) accurate. */
  function continuityFooter(jobId) {
    if (!jobId) {
      return "";
    }
    let stored = null;
    try {
      stored = findStoredCodexJob(dataDir(), jobId);
    } catch {
      return "";
    }
    if (!stored?.threadId) {
      return "";
    }
    return (
      "\n\n---" +
      `\nCodex session: ${stored.threadId}` +
      `\nResume in Codex: codex resume ${stored.threadId}` +
      `\nCodex job: ${stored.id ?? jobId}`
    );
  }

  function withContinuity(result) {
    const text = String(result?.text ?? "");
    return { text: `${text}${continuityFooter(result?.jobId)}` };
  }

  /**
   * Pre-flight consent for a write-capable Codex run. The Harness file sandbox
   * does not cover plugin-spawned processes, so a write run must be authorized
   * through the Harness approval service (which honors the session policy and
   * fails closed) or be an explicit human command. `writeApproval` config can
   * preauthorize (`allow`) or disable (`deny`) write runs.
   */
  async function ensureWriteAllowed(exec) {
    if (writeApprovalMode === "deny") {
      return {
        allowed: false,
        text:
          "Codex write runs are disabled by the plugin configuration " +
          '(writeApproval: "deny"). Re-run read-only, or change the plugin config.'
      };
    }
    if (writeApprovalMode === "allow") {
      return { allowed: true };
    }
    // A human typing `--write` in a slash command is once-only consent.
    if (exec?.fromCommand) {
      return { allowed: true };
    }
    const approval = ctx.get?.("approval");
    const agent = exec?.agent;
    if (!approval || !agent) {
      return {
        allowed: false,
        text:
          "Codex write access needs Harness approval, but no approval service/agent is " +
          'available for this call. Run read-only, or preauthorize writes with the plugin config writeApproval: "allow".'
      };
    }
    let outcome;
    try {
      outcome = await approval.request({
        agent,
        toolName: "codex_rescue",
        callId: exec?.callId,
        reason: "OpenAI Codex will edit files in this workspace.",
        displayReason: {
          en: "Allow OpenAI Codex to edit files in this workspace? Review its changes afterwards."
        },
        signal: exec?.signal
      });
    } catch (error) {
      return {
        allowed: false,
        text: `Codex write approval failed: ${
          error instanceof Error ? error.message : String(error)
        }. The run was not started.`
      };
    }
    if (outcome === "allowed-once") {
      return { allowed: true };
    }
    return {
      allowed: false,
      text:
        `Codex write access was not granted (${outcome ?? "unavailable"}); the run was not started. ` +
        "Re-run read-only or ask the user to allow it."
    };
  }

  async function foreground(exec, spec) {
    const result = await runCodexForeground({
      ctx,
      exec,
      runner,
      label: spec.label,
      cwd: spec.cwd,
      sessionId: sessionIdOf(exec),
      toolCall: toolCallOf(exec),
      buildArgv: spec.buildArgv,
      onSettled: spec.onSettled
    });
    return withContinuity(result);
  }

  function background(exec, spec) {
    const jobs = getJobs(ctx);
    if (!jobs) {
      throw new Error(
        "Background Codex runs need the Harness background-job service " +
          "(@deepseek-ai/dsh-jobs-local + @deepseek-ai/dsh-tool-jobs). Call again with background: false."
      );
    }
    let id;
    try {
      id = startCodexJob({
        jobs,
        runner,
        label: spec.label,
        cwd: spec.cwd,
        sessionId: sessionIdOf(exec),
        owner: exec?.agent?.id,
        toolCall: toolCallOf(exec),
        buildArgv: spec.buildArgv,
        onSettled: spec.onSettled
      });
    } catch (error) {
      // The caller owns prompt-file cleanup when we throw before registration.
      spec.onStartFailed?.();
      throw error;
    }
    backgroundJobs.set(id, { cwd: spec.cwd, sessionId: sessionIdOf(exec), label: spec.label });
    return {
      text:
        `${spec.label} is running as background job ${id}.\n` +
        `Continue with other work; you will be notified when it finishes. ` +
        `Use job_output ${id} for live progress, codex_result ${id} for the durable result ` +
        `(it includes the Codex thread id), or job_kill ${id} to cancel.`
    };
  }

  function storedStatusFallback(dir, jobId, sessionId) {
    if (jobId) {
      const stored = findStoredCodexJob(dir, jobId);
      return stored ? { text: renderStoredCodexJob(stored) } : null;
    }
    const jobs = listStoredCodexJobs(dir, { sessionId, limit: 8 });
    if (jobs.length > 0) {
      return {
        text: renderStoredCodexJobList(jobs, { title: "Codex jobs for this session:" })
      };
    }
    return null;
  }

  function storedResultFallback(dir, jobId, sessionId) {
    if (jobId) {
      const stored = findStoredCodexJob(dir, jobId);
      if (!stored) {
        return null;
      }
      if (!isTerminalStoredJob(stored)) {
        throw new Error(
          `Codex job ${stored.id} is still ${stored.status}. Use job_output to read live output.`
        );
      }
      return { text: renderStoredCodexJob(stored) };
    }
    const latest = listStoredCodexJobs(dir, {
      sessionId,
      limit: 1,
      terminalOnly: true
    })[0];
    return latest ? { text: renderStoredCodexJob(latest) } : null;
  }

  async function fast(exec, argv, cwd) {
    return runner.run(argv, {
      cwd,
      sessionId: sessionIdOf(exec),
      signal: exec?.signal
    });
  }

  function setup(exec, args = {}) {
    return (async () => {
      const cwd = resolveCwd(exec, args.cwd);
      const cached = setupCache.get(cwd);
      const now = Date.now();
      if (!args.force && cached && now - cached.at < SETUP_CACHE_TTL_MS) {
        const age = Math.max(1, Math.round((now - cached.at) / 1000));
        return {
          text: `${cached.text}\n\n(readiness cached ${age}s ago; pass force:true to re-check now)`
        };
      }
      const result = await fast(exec, setupArgv({ cwd }), cwd);
      assertOk("setup", result);
      const text = cleanOutput(result.stdout);
      setupCache.set(cwd, { at: now, text });
      return { text };
    })();
  }

  return {
    async review(exec, args = {}) {
      const cwd = resolveCwd(exec, args.cwd);
      const label = args.base
        ? `Codex review (base ${args.base})`
        : args.scope && args.scope !== "auto"
          ? `Codex review (${args.scope})`
          : "Codex review (working tree)";
      const buildArgv = (jobId) =>
        reviewArgv({ cwd, base: args.base, scope: args.scope, model: args.model, jobId });
      if (args.background) {
        return background(exec, { label, cwd, buildArgv });
      }
      return foreground(exec, { label, cwd, buildArgv });
    },

    async adversarialReview(exec, args = {}) {
      const cwd = resolveCwd(exec, args.cwd);
      const focusFile = args.focus ? writePromptFile(args.focus) : null;
      const cleanup = () => removePromptFile(focusFile);
      const label = args.base
        ? `Codex adversarial review (base ${args.base})`
        : "Codex adversarial review (working tree)";
      const buildArgv = (jobId) =>
        adversarialReviewArgv({
          cwd,
          base: args.base,
          scope: args.scope,
          model: args.model,
          jobId,
          focusFile
        });
      let cleanupOwned = false;
      try {
        if (args.background) {
          const result = background(exec, {
            label,
            cwd,
            buildArgv,
            onSettled: cleanup,
            onStartFailed: cleanup
          });
          cleanupOwned = true;
          return result;
        }
        return await foreground(exec, { label, cwd, buildArgv });
      } finally {
        if (!cleanupOwned) {
          cleanup();
        }
      }
    },

    async rescue(exec, args = {}) {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const resumeLast = Boolean(args.resume_last) && !args.fresh;
      if (!task && !resumeLast) {
        throw new Error(
          "Provide a task for Codex, or set resume_last to continue the previous Codex thread."
        );
      }
      if (args.write !== undefined && typeof args.write !== "boolean") {
        throw new Error("write must be a boolean.");
      }
      const cwd = resolveCwd(exec, args.cwd);
      const write = args.write === true;
      if (write) {
        const permission = await ensureWriteAllowed(exec);
        if (!permission.allowed) {
          return { text: permission.text };
        }
      }
      const promptFile = task ? writePromptFile(task) : null;
      const cleanup = () => removePromptFile(promptFile);
      const label = resumeLast ? "Codex resume" : `Codex task: ${shorten(task)}`;
      const buildArgv = (jobId) =>
        taskArgv({
          cwd,
          promptFile,
          model: args.model,
          effort: args.effort,
          write,
          resumeLast,
          jobId
        });
      let cleanupOwned = false;
      try {
        if (args.background) {
          const result = background(exec, {
            label,
            cwd,
            buildArgv,
            onSettled: cleanup,
            onStartFailed: cleanup
          });
          cleanupOwned = true;
          return result;
        }
        return await foreground(exec, { label, cwd, buildArgv });
      } finally {
        if (!cleanupOwned) {
          cleanup();
        }
      }
    },

    async status(exec, args = {}) {
      if (args.wait && !args.job_id) {
        throw new Error("status with wait: true needs a job_id.");
      }
      if (args.timeout_ms !== undefined) {
        const timeout = Number(args.timeout_ms);
        if (!Number.isInteger(timeout) || timeout <= 0) {
          throw new Error("timeout_ms must be a positive integer number of milliseconds.");
        }
      }
      const cwd = resolveCwd(exec, args.cwd);
      const dir = dataDir();
      if (args.job_id && !args.wait) {
        const stored = findStoredCodexJob(dir, args.job_id);
        if (stored && isTerminalStoredJob(stored)) {
          return { text: renderStoredCodexJob(stored) };
        }
      }
      let result;
      try {
        result = await fast(
          exec,
          statusArgv({
            cwd,
            jobId: args.job_id,
            all: Boolean(args.all),
            wait: Boolean(args.wait),
            timeoutMs: args.timeout_ms
          }),
          cwd
        );
      } catch (error) {
        // A missing/broken Codex install must not hide durable job records.
        const fallback = storedStatusFallback(dir, args.job_id, sessionIdOf(exec));
        if (fallback) {
          return fallback;
        }
        throw error;
      }
      if (result.code !== 0) {
        const fallback = storedStatusFallback(dir, args.job_id, sessionIdOf(exec));
        if (fallback) {
          return fallback;
        }
        assertOk("status", result);
      }
      const text = cleanOutput(result.stdout);
      if (!args.job_id && /no jobs recorded yet/i.test(text)) {
        const stored = listStoredCodexJobs(dir, { sessionId: sessionIdOf(exec), limit: 8 });
        if (stored.length > 0) {
          return {
            text: `${text}\n\n${renderStoredCodexJobList(stored, {
              title: "Codex jobs for this session in other workspaces:"
            })}`
          };
        }
      }
      return { text };
    },

    async result(exec, args = {}) {
      const cwd = resolveCwd(exec, args.cwd);
      const dir = dataDir();
      // Fast path: a terminal durable record needs no child process.
      if (args.job_id) {
        const stored = findStoredCodexJob(dir, args.job_id);
        if (stored && isTerminalStoredJob(stored)) {
          return { text: renderStoredCodexJob(stored) };
        }
      }
      let result;
      try {
        result = await fast(exec, resultArgv({ cwd, jobId: args.job_id }), cwd);
      } catch (error) {
        const fallback = storedResultFallback(dir, args.job_id, sessionIdOf(exec));
        if (fallback) {
          return fallback;
        }
        throw error;
      }
      if (result.code !== 0) {
        const fallback = storedResultFallback(dir, args.job_id, sessionIdOf(exec));
        if (fallback) {
          return fallback;
        }
        assertOk("result", result);
      }
      return { text: cleanOutput(result.stdout) };
    },

    async setup(exec, args = {}) {
      return setup(exec, args);
    },

    async cancel(exec, args = {}) {
      const cwd = resolveCwd(exec, args.cwd);
      const sessionId = sessionIdOf(exec);
      const jobs = getJobs(ctx);
      const requestedId = typeof args.job_id === "string" && args.job_id ? args.job_id : null;

      let targetId = requestedId;
      let targetCwd = requestedId ? backgroundJobs.get(requestedId)?.cwd ?? cwd : cwd;
      let killOutcome = null;

      if (jobs && targetId) {
        try {
          const view = jobs.get(targetId, sessionId);
          if (view) {
            killOutcome = isLiveStatus(view.status)
              ? jobs.kill(targetId, sessionId, "cancelled by request")
              : "already-finished";
          }
          // Unknown to this Harness session: the companion may still own a
          // durable/live record (for example after a plugin reload).
        } catch {
          // Not a live Harness job owned by this session; let the companion decide.
        }
      }

      if (jobs && !targetId) {
        const running = jobs
          .list(sessionId)
          .filter((view) => view.kind === "codex" && isLiveStatus(view.status));
        const inWorkspace = running.filter(
          (view) => (backgroundJobs.get(view.id)?.cwd ?? cwd) === cwd
        );
        if (inWorkspace.length > 1) {
          const ids = inWorkspace.map((view) => view.id).join(", ");
          throw new Error(
            `Multiple Codex jobs are running in this workspace (${ids}). Pass job_id to codex-cancel to choose one.`
          );
        }
        if (inWorkspace.length === 1) {
          targetId = inWorkspace[0].id;
          targetCwd = backgroundJobs.get(targetId)?.cwd ?? cwd;
          killOutcome = jobs.kill(targetId, sessionId, "cancelled by request");
        }
      }

      // When this adapter already killed a live Harness job, that job's cancel
      // hook has asked the companion to interrupt the turn; do not spawn a
      // second companion process for the same cancellation.
      const skipCompanionCancel = killOutcome !== null;
      let companionText = null;
      let companionError = null;
      try {
        if (skipCompanionCancel) {
          throw new Error("handled by the job cancel hook");
        }
        const result = await fast(
          exec,
          cancelArgv({ cwd: targetCwd, jobId: targetId ?? undefined }),
          targetCwd
        );
        if (result.code === 0) {
          companionText = cleanOutput(result.stdout);
        } else {
          companionError = cleanOutput(result.stderr) || cleanOutput(result.stdout) || `exit ${result.code}`;
        }
      } catch (error) {
        companionError = error instanceof Error ? error.message : String(error);
      }

      const lines = [];
      if (killOutcome === "requested") {
        lines.push(`Cancellation requested for Codex job ${targetId}.`);
      } else if (killOutcome === "already-finished") {
        lines.push(`Codex job ${targetId} had already finished.`);
      }
      if (companionText) {
        lines.push(companionText);
      } else if (companionError && !skipCompanionCancel) {
        lines.push(companionError);
      }
      if (lines.length === 0) {
        throw new Error(
          requestedId
            ? `No active Codex job with id ${requestedId}. Use codex_status to list known jobs.`
            : "There is no active Codex job to cancel in this workspace."
        );
      }
      if (requestedId && !killOutcome && !companionText) {
        throw new Error(
          `No active Codex job with id ${requestedId}.${companionError ? ` ${companionError}` : ""}`
        );
      }
      return { text: lines.join("\n") };
    }
  };
}
