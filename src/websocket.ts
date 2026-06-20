import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { botManager } from "./bot.js";
import { getConfig, saveConfig } from "./store.js";
import { logger } from "./lib/logger.js";

function send(ws: WebSocket, type: string, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcast(wss: WebSocketServer, type: string, payload: unknown) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function initPayload() {
  return {
    status: botManager.getStatus(),
    stats: botManager.getStats(),
    logs: botManager.getLogs(),
    config: getConfig(),
    storedPassword: botManager.getPassword(),
  };
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  botManager.setCallbacks({
    onStatus: (status, stats) => broadcast(wss, "status", { status, stats }),
    onLog: (entry) => broadcast(wss, "log", entry),
    onStats: (stats) => broadcast(wss, "stats", stats),
    onPassword: (password) => broadcast(wss, "password", password),
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    logger.info("WebSocket client connected");
    send(ws, "init", initPayload());

    ws.on("message", (raw: RawData) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };
      } catch {
        return;
      }

      if (msg.type === "start") {
        botManager.start();
      } else if (msg.type === "stop") {
        botManager.stop();
      } else if (msg.type === "chat") {
        botManager.sendChat(String(msg.message ?? ""));
      } else if (msg.type === "clearLogs") {
        botManager.clearLogs();
        // Tell every connected client to clear their log display too
        broadcast(wss, "clearLogs", null);
      } else if (msg.type === "config") {
        const cfg = saveConfig(msg.config as Parameters<typeof saveConfig>[0]);
        broadcast(wss, "init", { ...initPayload(), config: cfg });
      } else if (msg.type === "changeIp") {
        // Change host/port and immediately reconnect if bot is running
        const newHost = String(msg.host ?? "").trim();
        const newPort = Number(msg.port) || 25565;
        if (!newHost) return;
        const cfg = saveConfig({ host: newHost, port: newPort });
        broadcast(wss, "init", { ...initPayload(), config: cfg });
        // If bot is active, restart it on the new IP
        const s = botManager.getStatus();
        if (s === "online" || s === "connecting" || s === "disconnected") {
          botManager.start({ host: newHost, port: newPort });
        }
      }
    });

    ws.on("close", () => logger.info("WebSocket client disconnected"));
    ws.on("error", (err) => logger.error({ err }, "WebSocket error"));
  });

  return wss;
}
