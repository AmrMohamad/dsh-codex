#!/usr/bin/env node
/**
 * Minimal stand-in for the `codex` CLI, for end-to-end tests of the vendored
 * companion without a Codex install. Supports `--version`, `app-server --help`
 * and a JSON-RPC `app-server` that records every request to $FAKE_CODEX_LOG
 * (one JSON line each) and answers a turn with $FAKE_CODEX_REPLY.
 */
import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.163.0 (fake)\n");
  process.exit(0);
}
if (args[0] === "app-server" && args.includes("--help")) {
  process.stdout.write("Usage: codex app-server [OPTIONS]\n");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.stderr.write(`fake codex: unsupported arguments ${args.join(" ")}\n`);
  process.exit(2);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let threadSeq = 0;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (process.env.FAKE_CODEX_LOG) {
    fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
  }
  if (message.id === undefined) {
    return; // notification
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "thread/start":
      threadSeq += 1;
      reply({ thread: { id: `thr-${threadSeq}` } });
      notify("thread/started", { thread: { id: `thr-${threadSeq}`, name: null } });
      break;
    case "thread/resume":
      reply({ thread: { id: message.params.threadId } });
      break;
    case "turn/start": {
      const threadId = message.params.threadId;
      reply({ turn: { id: "turn-1", status: "inProgress" } });
      setImmediate(() => {
        notify("turn/started", { threadId, turn: { id: "turn-1" } });
        notify("item/completed", {
          threadId,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "msg-1", phase: "final_answer", text: process.env.FAKE_CODEX_REPLY ?? "ok" }
        });
        notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed", error: null } });
      });
      break;
    }
    default:
      reply({});
  }
});
