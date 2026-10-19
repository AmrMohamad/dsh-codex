import process from "node:process";

/** A fake Harness background-job registry that mirrors the real semantics used. */
export function createFakeJobs() {
  const records = new Map();
  let sequence = 0;

  const view = (record) => ({
    id: record.id,
    kind: record.spec.kind,
    label: record.spec.label,
    owner: record.spec.owner,
    status: record.status,
    detail: record.detail,
    progress: record.progress
  });

  const registry = {
    started: [],
    kills: [],
    start(spec) {
      const id = `codex-${(sequence += 1)}`;
      const chunks = [];
      let progress;
      const record = {
        id,
        spec,
        chunks,
        status: "running",
        detail: undefined,
        progress: undefined,
        outcome: undefined
      };
      const handle = {
        id,
        append(text, options = {}) {
          chunks.push({ text, channel: options.channel ?? "stdout" });
        },
        updateProgress(line) {
          record.progress = line;
        }
      };
      records.set(id, record);
      const hooks = spec.run(handle);
      record.hooks = hooks;
      record.promise = hooks.done.then(
        (outcome) => {
          record.outcome = outcome;
          record.status = outcome.status;
          record.detail = outcome.detail;
          return outcome;
        },
        (error) => {
          record.status = "failed";
          record.detail = String(error);
          record.outcome = { status: "failed", detail: String(error) };
          return record.outcome;
        }
      );
      registry.started.push(record);
      return id;
    },
    get(id) {
      const record = records.get(id);
      return record ? view(record) : undefined;
    },
    list() {
      return [...records.values()].map(view);
    },
    async wait(id) {
      const record = records.get(id);
      if (!record) {
        throw new Error(`unknown job ${id}`);
      }
      await record.promise;
      return view(record);
    },
    read(id) {
      const record = records.get(id);
      if (!record) {
        throw new Error(`unknown job ${id}`);
      }
      return { chunks: [...record.chunks], lossy: false, result: undefined, job: view(record) };
    },
    kill(id, _caller, reason) {
      const record = records.get(id);
      if (!record) {
        throw new Error(`unknown job ${id}`);
      }
      registry.kills.push({ id, reason });
      if (record.status !== "running") {
        return "already-finished";
      }
      record.status = "stopping";
      try {
        record.hooks?.cancel?.(reason);
      } catch {
        // The real registry propagates producer cancel throws; tests do not
        // depend on that behavior.
      }
      return "requested";
    },
    remove(id) {
      records.delete(id);
    },
    record(id) {
      return records.get(id);
    }
  };
  return registry;
}

/** A fake runner. `handler(argv, options)` may return a partial process result. */
export function createFakeRunner(handler = () => ({}), options = {}) {
  const calls = [];
  const dataDir = options.dataDir ?? "/tmp/fake-codex-data";
  return {
    calls,
    dataDir() {
      return dataDir;
    },
    ready() {
      return {
        node: { command: process.execPath, env: {}, source: "test" },
        codex: { command: "/fake/codex", source: "test" },
        dataDir
      };
    },
    env() {
      return {};
    },
    async run(argv, options = {}) {
      calls.push({ argv, options });
      const result = await handler(argv, options);
      const full = { code: 0, stdout: "", stderr: "", aborted: false, ...result };
      if (full.stdout) {
        options.onStdout?.(full.stdout);
      }
      if (full.stderr) {
        options.onStderr?.(full.stderr);
      }
      return full;
    }
  };
}

/** Fake Harness context with the minimal service surface the plugin uses. */
export function createFakeCtx(options = {}) {
  const tools = [];
  const commands = [];
  const sections = [];
  const skills = [];
  const disposers = [];

  const fakeServices = {
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      }
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
      context(context) {
        sections.push(context);
        return () => {};
      }
    },
    skills: {
      register(skill) {
        skills.push(skill);
        return () => {};
      }
    }
  };

  const cwd = options.cwd ?? process.cwd();
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        const disposer = () => {};
        disposers.push(disposer);
        return disposer;
      }
    },
    workingDirectory: {
      get: () => cwd,
      defaultDirectory: cwd,
      ensure: async () => cwd
    },
    get(name) {
      if (name === "jobs") {
        return options.jobs;
      }
      return undefined;
    },
    inject(deps, callback) {
      const scoped = { ...ctx, ...fakeServices };
      callback(scoped);
      return () => {};
    },
    effect(fn) {
      return fn();
    },
    on() {
      return () => {};
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  };

  return { ctx, tools, commands, sections, skills, disposers, cwd };
}
