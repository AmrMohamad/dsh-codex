/**
 * Harness background-job integration for Codex runs.
 *
 * Every Codex run (review, adversarial review, rescue task) is a native
 * DeepSeek Harness background job:
 *   - job_output / job_kill / job_list work unchanged,
 *   - completion notices wake the owning session,
 *   - cancellation kills the companion child and interrupts the Codex turn in
 *     the shared app-server broker.
 *
 * The vendored companion runtime is told the Harness job id via its patched
 * `--job-id` option, so the companion's durable job record and the Harness job
 * share one identity. That keeps `codex_status` / `codex_result` meaningful for
 * both foreground (removed after collection) and background runs.
 */
import { cancelArgv, cleanOutput } from "./runtime.js";

export const CODEX_JOB_KIND = "codex";
export const CODEX_JOB_OUTPUT_LIMIT = 256 * 1024;

export function getJobs(ctx) {
  try {
    return ctx.get("jobs");
  } catch {
    return undefined;
  }
}

function isTerminal(view) {
  return view.status !== "running" && view.status !== "stopping";
}

function tail(text, limit = 4000) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`;
}

/**
 * Turn the buffered job chunks into model-facing text. Codex progress lines
 * arrive on stderr; the rendered result arrives on stdout.
 *
 * @param {readonly { text: string; channel?: string }[]} chunks
 */
export function chunksToText(chunks) {
  const stdoutParts = [];
  const stderrParts = [];
  for (const chunk of chunks) {
    if (chunk.channel === "stderr") {
      stderrParts.push(chunk.text);
    } else {
      stdoutParts.push(chunk.text);
    }
  }
  const stdout = cleanOutput(stdoutParts.join(""));
  if (stdout) {
    return stdout;
  }
  return cleanOutput(stderrParts.join(""));
}

function failureDetail(view, stderr) {
  const detail = view.detail ? String(view.detail) : "";
  const cleaned = cleanOutput(stderr);
  if (cleaned && !detail.includes(cleaned)) {
    return cleaned ? `${detail || "Codex run failed."}\n${tail(cleaned)}` : tail(cleaned);
  }
  return detail || `Codex job ${view.id} ${view.status}.`;
}

/**
 * Start one Codex run as a Harness background job.
 *
 * @param {{
 *   jobs: any;
 *   runner: any;
 *   label: string;
 *   cwd: string;
 *   sessionId: string | null;
 *   owner?: string;
 *   toolCall?: { callId: string; rootCallId: string } | undefined;
 *   buildArgv: (jobId: string) => string[];
 *   onSettled?: () => void;
 * }} options
 * @returns {string}
 */
export function startCodexJob(options) {
  const { jobs, runner, label, cwd, sessionId } = options;
  return jobs.start({
    kind: CODEX_JOB_KIND,
    label,
    owner: options.owner,
    toolCall: options.toolCall,
    outputLimitBytes: CODEX_JOB_OUTPUT_LIMIT,
    run(job) {
      const controller = new AbortController();
      let cancelReason = null;
      let progressBuffer = "";

      const running = runner.run(options.buildArgv(job.id), {
        cwd,
        sessionId,
        signal: controller.signal,
        // Output already streams into the bounded job ring; do not accumulate a
        // second unbounded copy in the Host process.
        capture: false,
        onStdout(chunk) {
          job.append(chunk, { channel: "stdout" });
        },
        onStderr(chunk) {
          job.append(chunk, { channel: "stderr" });
          progressBuffer += chunk;
          const lines = progressBuffer.split(/\r?\n/);
          progressBuffer = lines.pop() ?? "";
          const last = lines.map((line) => line.trim()).filter(Boolean).pop();
          if (last) {
            job.updateProgress(last.slice(0, 200));
          }
        }
      });

      return {
        cancel(reason) {
          cancelReason = reason ?? "cancelled";
          // Stopping the child closes the broker client socket; the broker then
          // interrupts the turn it owned (even if the companion had not yet
          // persisted a turn id). The companion cancel below is the second
          // layer and also marks the durable record cancelled.
          controller.abort(cancelReason);
        },
        done: running.then(
          async (result) => {
            try {
              options.onSettled?.();
            } catch {
              // Cleanup must not change the job outcome.
            }
            if (result.aborted || cancelReason) {
              // Await the companion cancel so the durable record is terminal
              // before the Harness job settles (no "running" orphan records).
              try {
                await runner.run(cancelArgv({ cwd, jobId: job.id }), { cwd, sessionId });
              } catch {
                // The child is already gone; the broker interrupt remains the
                // primary cancellation mechanism.
              }
              // The registry merges the kill reason into `detail`; returning it
              // here too would duplicate the text in job_output's status line.
              return { status: "killed" };
            }
            if (result.error) {
              return { status: "failed", detail: result.error.message };
            }
            if (result.code === 0) {
              return { status: "completed" };
            }
            return {
              status: "failed",
              detail: `Codex companion exited with code ${result.code ?? "unknown"}.\n${tail(cleanOutput(result.stderr))}`
            };
          },
          (error) => {
            try {
              options.onSettled?.();
            } catch {
              // Ignore cleanup failure.
            }
            return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
          }
        )
      };
    }
  });
}

/**
 * Wait for a job to settle. The registry's wait has a bounded timeout per call,
 * so this loops without imposing an overall deadline.
 *
 * @param {any} jobs
 * @param {string} id
 * @param {string | undefined} caller
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<any>}
 */
export async function waitForJob(jobs, id, caller, signal) {
  for (;;) {
    const view = await jobs.wait(id, 300000, caller, signal);
    if (isTerminal(view)) {
      return view;
    }
  }
}

/**
 * Run one Codex operation in the foreground of a tool call: start the job,
 * wait, collect its output, and drop the record (the tool result already
 * carries the output).
 *
 * @param {{
 *   ctx: any;
 *   exec: any;
 *   runner: any;
 *   label: string;
 *   cwd: string;
 *   sessionId: string | null;
 *   buildArgv: (jobId: string) => string[];
 *   onSettled?: () => void;
 * }} options
 * @returns {Promise<{ text: string }>}
 */
export async function runCodexForeground(options) {
  const jobs = getJobs(options.ctx);
  const { exec } = options;
  const caller = options.sessionId ?? undefined;
  if (!jobs || !caller) {
    return runCodexDirect(options);
  }

  let id;
  try {
    id = startCodexJob({
      ...options,
      jobs,
      owner: caller,
      toolCall: options.toolCall
    });
  } catch (error) {
    if (/no job controller|background jobs unavailable/i.test(String(error?.message ?? ""))) {
      return runCodexDirect(options);
    }
    throw error;
  }

  let view;
  try {
    view = await waitForJob(jobs, id, caller, exec?.signal);
  } catch (error) {
    try {
      jobs.kill(id, caller, "tool call aborted");
    } catch {
      // Job may already be settling.
    }
    // Collect the aborted job so it does not linger in job_list or trigger a
    // completion notice. Bounded so a wedged producer cannot block the abort.
    try {
      await Promise.race([
        waitForJob(jobs, id, caller, undefined).then(() => undefined),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 10000);
          timer.unref?.();
        })
      ]);
      jobs.read(id, caller);
      jobs.remove(id, caller);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }

  const read = jobs.read(id, caller);
  try {
    jobs.remove(id, caller);
  } catch {
    // A completion-notice race must not hide the collected output.
  }

  const text = chunksToText(read.chunks ?? []) || cleanOutput(read.result ?? "");
  if (view.status !== "completed") {
    const stderr = (read.chunks ?? [])
      .filter((chunk) => chunk.channel === "stderr")
      .map((chunk) => chunk.text)
      .join("");
    throw new Error(failureDetail(view, stderr || text));
  }
  if (read.lossy) {
    return {
      text: `${text}\n\n[note: earlier Codex output exceeded the retainer and was dropped]`,
      jobId: id
    };
  }
  return { text: text || "(Codex finished with no output.)", jobId: id };
}

/**
 * Fallback for compositions without the jobs service: block the call.
 */
async function runCodexDirect(options) {
  const { runner, exec } = options;
  const jobId = `codex-${Date.now().toString(36)}`;
  const result = await runner.run(options.buildArgv(jobId), {
    cwd: options.cwd,
    sessionId: options.sessionId,
    signal: exec?.signal
  });
  try {
    options.onSettled?.();
  } catch {
    // Ignore cleanup failure.
  }
  if (result.aborted) {
    // The companion child is gone, but the shared broker keeps the Codex turn
    // alive. Interrupt it so a write-capable run cannot continue after cancel.
    try {
      Promise.resolve(
        runner.run(cancelArgv({ cwd: options.cwd, jobId }), {
          cwd: options.cwd,
          sessionId: options.sessionId
        })
      ).catch(() => {});
    } catch {
      // Best-effort interrupt.
    }
    throw new Error("Codex run was aborted.");
  }
  const text = cleanOutput(result.stdout) || cleanOutput(result.stderr);
  if (result.code !== 0 || result.error) {
    throw new Error(
      result.error?.message ??
        `Codex companion exited with code ${result.code ?? "unknown"}.\n${tail(text)}`
    );
  }
  return { text: text || "(Codex finished with no output.)", jobId };
}
