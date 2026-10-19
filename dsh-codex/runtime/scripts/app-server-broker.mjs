#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { shouldReapBroker } from "./lib/broker-idle.mjs";
import { createTurnTracker } from "./lib/broker-turns.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeRequestThreadIds = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  const turnTracker = createTurnTracker();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
      activeRequestThreadIds = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  /**
   * A client that owned a streaming turn disconnected (cancel, crash, or a
   * harness abort). Interrupt every turn it owned so a write-capable Codex turn
   * cannot keep running invisibly. Notifications may have arrived before the
   * start response, so the tracker is the source of the turn id.
   */
  function interruptOrphanedTurns(ownedThreadIds) {
    const targets = turnTracker.targets(ownedThreadIds);
    for (const target of targets) {
      // Bound the interrupt: a completed/unknown turn may not answer, and the
      // broker's forwarded-request queue must never hang on it.
      void withTimeout(
        appClient.request("turn/interrupt", target),
        5000,
        "turn/interrupt"
      ).catch(() => {});
    }
    turnTracker.forget(ownedThreadIds);
  }

  function handleSocketGone(socket) {
    const streamThreadIds =
      activeStreamSocket === socket && activeStreamThreadIds
        ? new Set(activeStreamThreadIds)
        : new Set();
    const requestThreadIds =
      activeRequestSocket === socket && activeRequestThreadIds
        ? new Set(activeRequestThreadIds)
        : new Set();
    sockets.delete(socket);
    clearSocketOwnership(socket);
    const owned = new Set([...streamThreadIds, ...requestThreadIds]);
    if (owned.size > 0) {
      interruptOrphanedTurns(owned);
    }
  }

  function routeNotification(message) {
    turnTracker.noteNotification(message);
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  let lastActivityAt = Date.now();
  const idleTimeoutMs = Number(process.env.CODEX_COMPANION_BROKER_IDLE_MS ?? "600000");
  const idleSweep = setInterval(() => {
    const reap = shouldReapBroker({
      activeRequest: activeRequestSocket !== null,
      activeStream: activeStreamSocket !== null,
      lastActivityAt,
      idleTimeoutMs,
      now: Date.now()
    });
    if (!reap) {
      return;
    }
    // No active turn owns this shared runtime. Close leftover idle sockets so a
    // leaked connection cannot pin the broker, then reap the app-server child.
    for (const socket of sockets) {
      try {
        socket.end();
      } catch {
        // Best effort: the process exits next.
      }
    }
    void shutdown(server).finally(() => process.exit(0));
  }, Math.min(60000, Math.max(5000, idleTimeoutMs / 4)));
  idleSweep.unref?.();

  async function shutdown(server) {
    clearInterval(idleSweep);
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);
  // If the app-server child dies, stop advertising a dead endpoint and exit so
  // clients fail fast instead of hanging on a silent turn.
  appClient.exitPromise.then(() => {
    void shutdown(server).finally(() => process.exit(0));
  });

  const server = net.createServer((socket) => {
    lastActivityAt = Date.now();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      lastActivityAt = Date.now();
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await withTimeout(
              appClient.request(message.method, message.params ?? {}),
              message.method === "turn/interrupt" ? 5000 : 60000,
              message.method
            );
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        activeRequestThreadIds = isStreaming
          ? new Set(buildStreamThreadIds(message.method, message.params ?? {}, null))
          : null;

        try {
          const result = await withTimeout(
            appClient.request(message.method, message.params ?? {}),
            message.method === "turn/interrupt" ? 5000 : 60000,
            message.method
          );
          send(socket, { id: message.id, result });
          if (isStreaming) {
            turnTracker.noteStreamingResult(message.method, message.params ?? {}, result);
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
            activeRequestThreadIds = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
            activeRequestThreadIds = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      handleSocketGone(socket);
    });

    socket.on("error", () => {
      handleSocketGone(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
