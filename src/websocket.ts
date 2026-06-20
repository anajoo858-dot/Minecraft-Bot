import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { URL } from "node:url";
import { BotManager } from "./bot.js";
import { getConfig, saveConfig } from "./store.js";
import { logger } from "./lib/logger.js";

const SESSION_IDLE_MS = 30 * 60 * 1000; // stop bot after 30 min with no clients

interface SessionData {
  manager: BotManager;
  clients: Set<WebSocket>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionData>();

function getOrCreateSession(sessionId: string): SessionData {
  if (!sessions.has(sessionId)) {
    const manager = new BotManager(sessionId);
    sessions.set(sessionId, { manager, clients: new Set(), cleanupTimer: null });
    logger.info({ sessionId: sessionId.slice(0, 8) }, "New session created");
  }
  return sessions.get(sessionId)!;
}

function scheduleSessionCleanup(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);

  session.cleanupTimer = setTimeout(() => {
    const s = sessions.get(sessionId);
    if (!s || s.clients.size > 0) return;
    s.manager.destroy();
    sessions.delete(sessionId);
    logger.info({ sessionId: sessionId.slice(0, 8) }, "Session cleaned up after idle");
  }, SESSION_IDLE_MS);
}

function send(ws: WebSocket, type: string, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastToSession(session: SessionData, type: string, payload: unknown) {
  const msg = JSON.stringify({ type, payload });
  session.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function initPayload(sessionId: string, manager: BotManager) {
  return {
    status: manager.getStatus(),
    stats: manager.getStats(),
    logs: manager.getLogs(),
    config: getConfig(sessionId),
    storedPassword: manager.getPassword(),
  };
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const reqUrl = new URL(req.url ?? "/ws", "http://localhost");
    let sessionId = reqUrl.searchParams.get("session") ?? "";

    // Validate: alphanumeric + hyphens only, 8–64 chars
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) {
      sessionId = `anon-${Date.now()}`;
    }

    const session = getOrCreateSession(sessionId);
    session.clients.add(ws);

    // Cancel any pending cleanup
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    // Wire up callbacks so this session's events only go to this session's clients
    session.manager.setCallbacks({
      onStatus: (status, stats) => broadcastToSession(session, "status", { status, stats }),
      onLog:    (entry)        => broadcastToSession(session, "log", entry),
      onStats:  (stats)        => broadcastToSession(session, "stats", stats),
      onPassword: (password)   => broadcastToSession(session, "password", password),
    });

    logger.info({ sessionId: sessionId.slice(0, 8), clients: session.clients.size }, "Client connected");
    send(ws, "init", initPayload(sessionId, session.manager));

    ws.on("message", (raw: RawData) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };
      } catch { return; }

      const mgr = session.manager;

      if (msg.type === "start") {
        mgr.start();
      } else if (msg.type === "stop") {
        mgr.stop();
      } else if (msg.type === "chat") {
        mgr.sendChat(String(msg.message ?? ""));
      } else if (msg.type === "clearLogs") {
        mgr.clearLogs();
        broadcastToSession(session, "clearLogs", null);
      } else if (msg.type === "config") {
        const cfg = saveConfig(sessionId, msg.config as Parameters<typeof saveConfig>[1]);
        broadcastToSession(session, "init", { ...initPayload(sessionId, mgr), config: cfg });
      } else if (msg.type === "changeIp") {
        const newHost = String(msg.host ?? "").trim();
        const newPort = Number(msg.port) || 25565;
        if (!newHost) return;
        const cfg = saveConfig(sessionId, { host: newHost, port: newPort });
        broadcastToSession(session, "init", { ...initPayload(sessionId, mgr), config: cfg });
        const s = mgr.getStatus();
        if (s === "online" || s === "connecting" || s === "disconnected") {
          mgr.start({ host: newHost, port: newPort });
        }
      }
    });

    ws.on("close", () => {
      session.clients.delete(ws);
      logger.info({ sessionId: sessionId.slice(0, 8), clients: session.clients.size }, "Client disconnected");
      if (session.clients.size === 0) scheduleSessionCleanup(sessionId);
    });

    ws.on("error", (err) => logger.error({ err }, "WebSocket error"));
  });

  return wss;
}
