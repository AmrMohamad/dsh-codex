#!/usr/bin/env node
/**
 * No-model probe: Codex 0.163 app-server native unix-socket transport
 * (`--listen unix://...`) — potential replacement for the plugin's custom
 * shared broker (scripts/app-server-broker.mjs).
 *
 * Findings this script verifies:
 *  - `codex app-server --listen unix://PATH` creates a unix socket that speaks
 *    **WebSocket** (HTTP Upgrade) whose text frames carry one JSON-RPC message
 *    each. Plain newline-delimited JSON over the raw socket is rejected.
 *  - Bare `--listen unix://` listens on
 *    $CODEX_HOME/app-server-control/app-server-control.sock.
 *  - Two independent WebSocket clients can initialize and create threads
 *    concurrently against one app-server.
 *  - `codex app-server proxy --sock <control socket>` bridging (observed even
 *    though the daemon itself cannot be started in this sandbox).
 *
 * Run: node probes/probe-unix-listen.mjs [--report <path>]
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { probeEnv, ensureProbeCodexHome } from "./lib-probe-home.mjs";

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BIN = process.env.CODEX_BIN || "codex";

function parseArgs(argv) {
  const args = { report: path.join(PROBE_DIR, "report-unix-listen.json") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report") args.report = path.resolve(argv[++i]);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPath(targetPath, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(targetPath)) return true;
    await sleep(50);
  }
  return false;
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Minimal RFC6455 WebSocket client over the app-server unix control socket. */
class WsClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.raw = Buffer.alloc(0);
    this.upgraded = false;
    this.closed = false;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket = net.createConnection({ path: this.socketPath });
      this.socket.on("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        this.socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.socket.on("error", reject);
      this.socket.on("close", () => {
        this.closed = true;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("socket closed"));
        }
        this.pending.clear();
      });
      this.socket.on("data", (chunk) => this.onData(chunk, resolve, reject));
    });
    return this;
  }

  onData(chunk, resolveConnect, rejectConnect) {
    this.raw = Buffer.concat([this.raw, chunk]);
    if (!this.upgraded) {
      const headerEnd = this.raw.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = this.raw.slice(0, headerEnd).toString();
      this.handshake = head.split("\r\n")[0];
      this.raw = this.raw.slice(headerEnd + 4);
      if (!/^HTTP\/1\.1 101/.test(this.handshake)) {
        rejectConnect(new Error(`unexpected upgrade response: ${this.handshake}`));
        return;
      }
      this.upgraded = true;
      resolveConnect();
    }
    this.parseFrames();
  }

  parseFrames() {
    while (this.raw.length >= 2) {
      const byte0 = this.raw[0];
      const byte1 = this.raw[1];
      const opcode = byte0 & 0x0f;
      let length = byte1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.raw.length < 4) return;
        length = this.raw.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.raw.length < 10) return;
        length = Number(this.raw.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (byte1 & 0x80) !== 0;
      if (masked) offset += 4;
      if (this.raw.length < offset + length) return;
      const payload = this.raw.slice(offset, offset + length);
      this.raw = this.raw.slice(offset + length);
      if (opcode === 0x1) {
        this.onText(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.closed = true;
      } else if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
      }
    }
  }

  onText(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.notifications.push({ method: "unparseable", text });
      return;
    }
    if (message.id !== undefined && message.method) {
      this.sendText(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } }));
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? "request failed");
        error.rpc = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.notifications.push({ method: message.method, params: message.params });
  }

  sendFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  sendText(text) {
    this.sendFrame(0x1, text);
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendText(JSON.stringify({ id, method, params }));
    });
  }

  notify(method, params = {}) {
    this.sendText(JSON.stringify({ method, params }));
  }

  close() {
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
    } catch {}
    try {
      this.socket.end();
    } catch {}
  }
}

const INITIALIZE = {
  clientInfo: { title: "Codex Plugin", name: "Claude Code", version: "0.0.0-probe" },
  capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] }
};

function startServer({ home, args, label }) {
  const proc = spawn(CODEX_BIN, ["app-server", ...args], {
    cwd: os.tmpdir(),
    env: { ...probeEnv(), CODEX_HOME: home },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state = { label, proc, stdout: "", stderr: "" };
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    state.stdout += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  return state;
}

async function killServer(state) {
  if (state.proc.exitCode !== null) return { code: state.proc.exitCode, signal: state.proc.signal };
  state.proc.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => state.proc.once("exit", (code, signal) => resolve({ code, signal }))),
    sleep(3000).then(() => ({ timeout: true }))
  ]);
  if (state.proc.exitCode === null) {
    state.proc.kill("SIGKILL");
    await sleep(300);
  }
  return exited;
}

const THREAD_START_PARAMS = { cwd: os.tmpdir(), approvalPolicy: "never", sandbox: "read-only", ephemeral: true };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = ensureProbeCodexHome();
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      codexVersion: spawnSync(CODEX_BIN, ["--version"], { encoding: "utf8" }).stdout.trim(),
      codexHome: home
    },
    explicitSocket: null,
    bareUnixListen: null,
    proxyBridge: null,
    daemonVersionCommand: null
  };

  // 1) Explicit unix socket path; two concurrent WebSocket clients.
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-sock-")), "app-server.sock");
  const server = startServer({ home, args: ["--listen", `unix://${socketPath}`], label: "explicit" });
  const ready = await waitForPath(socketPath);
  report.explicitSocket = {
    command: `${CODEX_BIN} app-server --listen unix://${socketPath}`,
    socketPath,
    socketCreated: ready
  };
  if (ready) {
    const clientA = await new WsClient(socketPath).connect();
    const clientB = await new WsClient(socketPath).connect();
    try {
      const [initA, initB] = await Promise.all([
        clientA.request("initialize", INITIALIZE),
        clientB.request("initialize", {
          ...INITIALIZE,
          clientInfo: { ...INITIALIZE.clientInfo, name: "second-client" }
        })
      ]);
      clientA.notify("initialized", {});
      clientB.notify("initialized", {});
      const [startA, startB] = await Promise.all([
        clientA.request("thread/start", THREAD_START_PARAMS),
        clientB.request("thread/start", THREAD_START_PARAMS)
      ]);
      report.explicitSocket.handshake = clientA.handshake;
      report.explicitSocket.clients = {
        initializeA: initA,
        initializeB: initB,
        threadStartA: { id: startA.thread?.id, source: startA.thread?.source, ephemeral: startA.thread?.ephemeral },
        threadStartB: { id: startB.thread?.id, source: startB.thread?.source, ephemeral: startB.thread?.ephemeral },
        concurrentClientsOk: true
      };
    } catch (error) {
      report.explicitSocket.clients = { error: error.message };
    } finally {
      clientA.close();
      clientB.close();
    }

    // 1b) Official `codex app-server proxy --sock` bridge against this socket.
    const proxy = spawn(CODEX_BIN, ["app-server", "proxy", "--sock", socketPath], {
      env: { ...probeEnv(), CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let proxyOut = "";
    let proxyErr = "";
    proxy.stdout.setEncoding("utf8");
    proxy.stderr.setEncoding("utf8");
    proxy.stdout.on("data", (chunk) => {
      proxyOut += chunk;
    });
    proxy.stderr.on("data", (chunk) => {
      proxyErr += chunk;
    });
    proxy.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: INITIALIZE })}\n`);
    const proxyExit = await Promise.race([
      new Promise((resolve) => proxy.once("exit", (code, signal) => resolve({ code, signal }))),
      sleep(4000).then(() => ({ timeout: true }))
    ]);
    if (proxy.exitCode === null) proxy.kill("SIGTERM");
    report.proxyBridge = {
      command: `${CODEX_BIN} app-server proxy --sock ${socketPath}`,
      exit: proxyExit,
      stdout: proxyOut.trim(),
      stderr: proxyErr.trim()
    };
  }
  report.explicitSocket.exit = await killServer(server);
  report.explicitSocket.stderr = server.stderr.trim();

  // 2) Bare `--listen unix://` => $CODEX_HOME/app-server-control/app-server-control.sock
  const before = new Set(walkFiles(home));
  const bare = startServer({ home, args: ["--listen", "unix://"], label: "bare" });
  await sleep(2500);
  const created = walkFiles(home).filter((file) => !before.has(file) && file.endsWith(".sock"));
  report.bareUnixListen = {
    command: `${CODEX_BIN} app-server --listen unix://`,
    socketFilesCreated: created,
    serverStillRunning: bare.proc.exitCode === null,
    stderr: bare.stderr.trim()
  };
  const defaultSocket = path.join(home, "app-server-control", "app-server-control.sock");
  if (created.includes(defaultSocket) || fs.existsSync(defaultSocket)) {
    try {
      const client = await new WsClient(defaultSocket).connect();
      report.bareUnixListen.handshake = client.handshake;
      report.bareUnixListen.initialize = await client.request("initialize", INITIALIZE);
      client.notify("initialized", {});
      const started = await client.request("thread/start", THREAD_START_PARAMS);
      report.bareUnixListen.threadStart = {
        id: started.thread?.id,
        source: started.thread?.source,
        ephemeral: started.thread?.ephemeral
      };
      client.close();
    } catch (error) {
      report.bareUnixListen.connectError = error.message;
    }
  }
  report.bareUnixListen.exit = await killServer(bare);

  // 3) `daemon version` (no daemon running in the probe home).
  const daemonVersion = spawnSync(CODEX_BIN, ["app-server", "daemon", "version"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home },
    timeout: 15_000
  });
  report.daemonVersionCommand = {
    command: `${CODEX_BIN} app-server daemon version`,
    status: daemonVersion.status,
    stdout: daemonVersion.stdout.trim(),
    stderr: daemonVersion.stderr.trim()
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
