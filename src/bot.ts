import mineflayer, { type Bot } from "mineflayer";
import { SocksClient } from "socks";
import { logger } from "./lib/logger.js";
import { getConfig, getOrCreatePassword, type BotConfig } from "./store.js";

export type BotStatus = "stopped" | "connecting" | "online" | "disconnected" | "error";

export interface BotStats {
  health: number;
  food: number;
  ping: number;
  players: number;
  reconnects: number;
  dropped: number;
  uptime: number;
  pos: { x: number; y: number; z: number } | null;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "success" | "chat";
  message: string;
}

type StatusCallback = (status: BotStatus, stats?: BotStats) => void;
type LogCallback = (entry: LogEntry) => void;
type StatsCallback = (stats: BotStats) => void;
type PasswordCallback = (password: string | null) => void;

const MAX_LOGS = 500;

const ARMOR_SLOTS: Record<string, "head" | "torso" | "legs" | "feet"> = {};
for (const m of ["leather", "chainmail", "iron", "golden", "diamond", "netherite", "turtle"]) {
  ARMOR_SLOTS[`${m}_helmet`] = "head";
}
ARMOR_SLOTS["carved_pumpkin"] = "head";
ARMOR_SLOTS["player_head"]    = "head";
for (const m of ["leather", "chainmail", "iron", "golden", "diamond", "netherite"]) {
  ARMOR_SLOTS[`${m}_chestplate`] = "torso";
}
ARMOR_SLOTS["elytra"] = "torso";
for (const m of ["leather", "chainmail", "iron", "golden", "diamond", "netherite"]) {
  ARMOR_SLOTS[`${m}_leggings`] = "legs";
}
for (const m of ["leather", "chainmail", "iron", "golden", "diamond", "netherite"]) {
  ARMOR_SLOTS[`${m}_boots`] = "feet";
}

function armorSlot(itemName: string): "head" | "torso" | "legs" | "feet" | null {
  return ARMOR_SLOTS[itemName] ?? null;
}

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

export class BotManager {
  private sessionId: string;
  private bot: Bot | null = null;
  private status: BotStatus = "stopped";
  private stats: BotStats = { health: 0, food: 0, ping: 0, players: 0, reconnects: 0, dropped: 0, uptime: 0, pos: null };
  private logs: LogEntry[] = [];

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;
  private attackTimer: ReturnType<typeof setInterval> | null = null;
  private movementTimer: ReturnType<typeof setInterval> | null = null;
  // FIX: track the forward-release timeout so it can be cancelled on disconnect
  private forwardTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime: number | null = null;
  private shouldReconnect = false;
  private currentConfig: BotConfig | null = null;
  private currentPassword: string | null = null;
  // FIX: flag to suppress reconnect when server is doing a transfer
  private transferring = false;

  private onStatus: StatusCallback = () => {};
  private onLog: LogCallback = () => {};
  private onStats: StatsCallback = () => {};
  private onPassword: PasswordCallback = () => {};

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  setCallbacks(cb: {
    onStatus: StatusCallback;
    onLog: LogCallback;
    onStats: StatsCallback;
    onPassword: PasswordCallback;
  }) {
    this.onStatus = cb.onStatus;
    this.onLog = cb.onLog;
    this.onStats = cb.onStats;
    this.onPassword = cb.onPassword;
  }

  getLogs(): LogEntry[] { return this.logs; }
  getStatus(): BotStatus { return this.status; }
  getStats(): BotStats { return this.stats; }
  getPassword(): string | null { return this.currentPassword; }

  clearLogs(): void {
    this.logs = [];
  }

  private log(level: LogEntry["level"], message: string) {
    const entry: LogEntry = { ts: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.onLog(entry);
    const pinoLevel = (level === "success" || level === "chat") ? "info" : level;
    logger[pinoLevel]({ session: this.sessionId.slice(0, 8), msg: message });
  }

  private setStatus(s: BotStatus) {
    this.status = s;
    this.onStatus(s, this.stats);
  }

  private emitStats() {
    this.onStats({ ...this.stats });
  }

  start(overrideConfig?: Partial<BotConfig>) {
    if (this.bot) this.destroyBot(false);
    this.cancelReconnect();
    this.shouldReconnect = true;
    this.transferring = false;

    const cfg = { ...getConfig(this.sessionId), ...overrideConfig };
    this.currentConfig = cfg;

    if (!cfg.host) {
      this.log("error", "No host configured — fill in the Config tab first");
      return;
    }

    this.spawnBot(cfg);
  }

  stop() {
    this.shouldReconnect = false;
    this.transferring = false;
    this.cancelReconnect();
    this.destroyBot(true);
    this.setStatus("stopped");
    this.log("info", "Bot stopped by user");
  }

  destroy() {
    this.shouldReconnect = false;
    this.transferring = false;
    this.cancelReconnect();
    this.destroyBot(true);
  }

  sendChat(message: string) {
    if (this.bot && this.status === "online") {
      this.bot.chat(message);
    }
  }

  private spawnBot(cfg: BotConfig) {
    this.setStatus("connecting");
    this.transferring = false;
    this.log("info", `Connecting to ${cfg.host}:${cfg.port} as ${cfg.username}…`);

    if (cfg.autoAuth) {
      this.currentPassword = getOrCreatePassword(this.sessionId, cfg.host, cfg.port);
      this.onPassword(this.currentPassword);
      this.log("info", `Auto-auth enabled — password ready for ${cfg.host}:${cfg.port}`);
    } else {
      this.currentPassword = null;
      this.onPassword(null);
    }

    if (cfg.proxyEnabled && cfg.proxyHost) {
      this.log("info", `🔀 Routing through SOCKS5 proxy ${cfg.proxyHost}:${cfg.proxyPort}`);
    }

    let bot: Bot;
    try {
      const botOptions: Parameters<typeof mineflayer.createBot>[0] = {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        version: cfg.version || undefined,
        auth: "offline",
        hideErrors: false,
        checkTimeoutInterval: 30_000,
        keepAlive: true,
      };

      if (cfg.proxyEnabled && cfg.proxyHost) {
        const proxyHost = cfg.proxyHost;
        const proxyPort = cfg.proxyPort;
        const proxyUser = cfg.proxyUsername;
        const proxyPass = cfg.proxyPassword;
        const destHost  = cfg.host;
        const destPort  = cfg.port;

        botOptions.connect = (client) => {
          this.log("info", `🔌 Connecting SOCKS5 to ${proxyHost}:${proxyPort} → ${destHost}:${destPort}…`);
          SocksClient.createConnection(
            {
              proxy: {
                host: proxyHost,
                port: proxyPort,
                type: 5,
                ...(proxyUser ? { userId: proxyUser, password: proxyPass } : {}),
              },
              command: "connect",
              destination: { host: destHost, port: destPort },
              timeout: 10_000,
            },
            (err, info) => {
              if (err || !info) {
                const msg = err?.message ?? "no info returned";
                this.log("error", `❌ SOCKS5 tunnel failed: ${msg} — proxy may be dead or blocking port ${destPort}`);
                client.emit("error", err ?? new Error("SOCKS5 connection failed"));
                return;
              }
              this.log("info", `✅ SOCKS5 tunnel established — handshaking with Minecraft server…`);
              const sock = info.socket;
              sock.once("close", () => this.log("warn", "⚠️ SOCKS5 socket closed by proxy"));
              sock.once("error", (e) => this.log("error", `⚠️ SOCKS5 socket error: ${e.message}`));
              client.setSocket(sock);
              client.emit("connect");
            },
          );
        };
      }

      bot = mineflayer.createBot(botOptions);
    } catch (err) {
      this.log("error", `Failed to create bot: ${String(err)}`);
      this.setStatus("error");
      this.scheduleReconnect();
      return;
    }

    this.bot = bot;

    bot.once("login", () => {
      this.log("success", `Logged in as ${bot.username}`);
    });

    bot.once("spawn", () => {
      this.reconnectAttempts = 0;
      this.startTime = Date.now();
      this.setStatus("online");
      this.log("success", `Spawned in world — ${cfg.host}:${cfg.port}`);

      if (cfg.autoAuth && this.currentPassword) {
        const pw = this.currentPassword;
        // FIX: Send login faster (200ms) so we beat the typical 1-second auth kick timer.
        // We rely ONLY on this proactive attempt + the message handler as fallback.
        // Do NOT also send in the message handler if the proactive one already succeeded.
        setTimeout(() => {
          if (this.bot === bot && this.status === "online") {
            this.log("info", "Auto-auth: sending /login on spawn…");
            bot.chat(`/login ${pw}`);
          }
        }, 200);
        // Delay attack/movement until after auth window has fully passed
        setTimeout(() => this.startTimers(bot, cfg), 4000);
      } else {
        this.startTimers(bot, cfg);
      }
    });

    // FIX: Handle 1.20.5+ server transfer packets — stop timers immediately
    // so no movement/attack packets are sent during the transfer window.
    // Do NOT reconnect; the transfer is handled externally.
    bot.on("transfer" as Parameters<typeof bot.on>[0], (host: unknown, port: unknown) => {
      this.log("info", `🔀 Server transfer → ${host}:${port} — pausing bot…`);
      this.transferring = true;
      this.stopTimers();
      try { bot.clearControlStates(); } catch {}
      // After a short window let the new spawn re-enable timers
      setTimeout(() => { this.transferring = false; }, 10_000);
    });

    bot.on("chat", (username, message) => {
      if (username === bot.username) return;
      this.log("chat", `<${username}> ${message}`);
    });

    bot.on("message", (jsonMsg) => {
      this.handleAuthMessage(bot, jsonMsg.toString(), cfg);
    });

    bot.on("kicked", (reason) => {
      this.stopTimers();
      try { bot.clearControlStates(); } catch {}
      this.log("warn", `Kicked: ${reason}`);
      this.handleDisconnect();
    });

    bot.on("end", (reason) => {
      // FIX: stop timers AND cancel the loose forward-release timeout immediately
      // BEFORE anything else, so no stale packets fire during a server transfer window.
      this.stopTimers();
      try { bot.clearControlStates(); } catch {}

      // FIX: if the server is doing a BungeeCord-style redirect, the end event fires
      // but we should not immediately reconnect — wait briefly to let the new
      // connection establish via the spawn event on the new server.
      const lowerReason = (reason ?? "").toLowerCase();
      const isTransfer =
        lowerReason.includes("transfer") ||
        lowerReason.includes("redirect") ||
        lowerReason.includes("moving") ||
        this.transferring;

      if (isTransfer) {
        this.log("info", `Server redirect detected (${reason || "transfer"}) — waiting for new spawn…`);
        // Give the new server 12 seconds to spawn the bot before we treat it as a real disconnect
        setTimeout(() => {
          if (this.status !== "online") {
            this.log("warn", "No spawn after redirect — reconnecting normally…");
            this.handleDisconnect();
          }
        }, 12_000);
        return;
      }

      this.log("warn", `Connection ended: ${reason || "unknown"}`);
      this.handleDisconnect();
    });

    bot.on("error", (err) => {
      this.log("error", `Bot error: ${err.message}`);
    });

    bot.on("death", () => {
      this.log("warn", "Bot died — respawning…");
      bot.respawn();
    });

    bot.on("health", () => {
      this.stats.health = Math.round((bot.health / 20) * 100);
      this.stats.food = Math.round((bot.food / 20) * 100);
      this.emitStats();
    });

    bot.on("playerJoined", () => {
      this.stats.players = Object.keys(bot.players).length;
      this.emitStats();
    });

    bot.on("playerLeft", () => {
      this.stats.players = Object.keys(bot.players).length;
      this.emitStats();
    });

    if (cfg.autoDrop) {
      bot.on("playerCollect", (collector) => {
        if (collector.username !== bot.username) return;
        setTimeout(() => {
          if (!bot.inventory) return;
          const items = bot.inventory.items();
          let count = 0;
          const dropNext = (i: number) => {
            if (i >= items.length) {
              if (count > 0) { this.stats.dropped += count; this.emitStats(); }
              return;
            }
            bot.tossStack(items[i])
              .then(() => { count++; dropNext(i + 1); })
              .catch(() => dropNext(i + 1));
          };
          dropNext(0);
        }, 600);
      });
    } else {
      bot.on("playerCollect", (collector) => {
        if (collector.username !== bot.username) return;
        setTimeout(() => {
          if (!bot.inventory) return;
          const items = bot.inventory.items();
          const equipNext = (i: number) => {
            if (i >= items.length) return;
            const item = items[i];
            const slot = armorSlot(item.name);
            if (!slot) { equipNext(i + 1); return; }
            bot.equip(item, slot)
              .then(() => {
                this.log("info", `🛡 Equipped ${item.displayName ?? item.name}`);
                equipNext(i + 1);
              })
              .catch(() => equipNext(i + 1));
          };
          equipNext(0);
        }, 800);
      });
    }
  }

  private handleAuthMessage(bot: Bot, text: string, cfg: BotConfig) {
    if (!cfg.autoAuth || !this.currentPassword) return;
    const lower = text.toLowerCase();

    // FIX: Expanded auth patterns covering AuthMe, LoginSecurity, nLogin, and others.
    const isRegister =
      lower.includes("/register") ||
      lower.includes("please register") ||
      lower.includes("you need to register") ||
      lower.includes("register to play") ||
      lower.includes("use /register") ||
      lower.includes("not registered") ||
      lower.includes("haven't registered") ||
      lower.includes("register first") ||
      lower.includes("account does not exist") ||
      lower.includes("create an account") ||
      lower.includes("no account") ||
      lower.includes("unknown account") ||
      lower.includes("this account") ||
      lower.includes("para registrarte") ||
      lower.includes("registrate") ||
      lower.includes("registrieren");

    const isLogin =
      lower.includes("/login") ||
      lower.includes("please login") ||
      lower.includes("you need to login") ||
      lower.includes("please log in") ||
      lower.includes("use /login") ||
      lower.includes("not logged") ||
      lower.includes("not authenticated") ||
      lower.includes("authenticate") ||
      lower.includes("log in to") ||
      lower.includes("login to") ||
      lower.includes("wrong password") ||
      lower.includes("incorrect password") ||
      lower.includes("session expired") ||
      lower.includes("inicia sesion") ||
      lower.includes("iniciar sesion") ||
      lower.includes("einloggen") ||
      lower.includes("identifie");

    const pw = this.currentPassword;

    if (isRegister) {
      this.log("info", "Auth plugin detected — registering with saved password");
      // FIX: send register faster (100ms) to beat kick timers, then login at 400ms
      setTimeout(() => {
        if (this.bot === bot && this.status === "online") {
          bot.chat(`/register ${pw} ${pw}`);
          setTimeout(() => {
            if (this.bot === bot && this.status === "online") {
              bot.chat(`/login ${pw}`);
            }
          }, 400);
        }
      }, 100);
      return;
    }

    if (isLogin) {
      // Only respond to login prompts if we haven't already proactively sent /login
      // (the spawn handler sends at 200ms, so skip if bot just spawned within 1.5s)
      if (this.startTime && Date.now() - this.startTime < 1_500) return;
      this.log("info", "Auth plugin detected — logging in with saved password");
      // FIX: send login faster (100ms) to beat kick timers
      setTimeout(() => {
        if (this.bot === bot && this.status === "online") {
          bot.chat(`/login ${pw}`);
        }
      }, 100);
    }
  }

  private handleDisconnect() {
    this.stopTimers();
    this.setStatus("disconnected");
    if (!this.shouldReconnect) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || !this.currentConfig) return;
    this.cancelReconnect();

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(1.5, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.stats.reconnects++;

    this.log("info", `Reconnecting in ${Math.round(delay / 1000)}s… (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      if (!this.shouldReconnect || !this.currentConfig) return;
      this.destroyBot(false);
      this.spawnBot(this.currentConfig);
    }, delay);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private startTimers(bot: Bot, cfg: BotConfig) {
    this.stopTimers();

    this.uptimeTimer = setInterval(() => {
      if (this.startTime) this.stats.uptime = Math.floor((Date.now() - this.startTime) / 1000);
      this.stats.ping = bot.player?.ping ?? 0;
      this.stats.players = Object.keys(bot.players).length;
      const p = bot.entity?.position;
      if (p) this.stats.pos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      this.emitStats();
    }, 2000);

    if (cfg.randomMovement && cfg.attackMode === "off") {
      const MOVES = ["forward", "back", "left", "right"] as const;
      this.movementTimer = setInterval(() => {
        if (this.status !== "online") return;
        const key = MOVES[Math.floor(Math.random() * MOVES.length)];
        bot.setControlState(key, true);
        setTimeout(() => bot.setControlState(key, false), 400 + Math.random() * 600);
        if (Math.random() < 0.3) {
          bot.setControlState("jump", true);
          setTimeout(() => bot.setControlState("jump", false), 300);
        }
      }, 8000 + Math.random() * 7000);
    }

    if (cfg.attackMode !== "off") {
      const mode = cfg.attackMode;
      const targetName = cfg.attackPlayerName?.toLowerCase() ?? "";

      this.attackTimer = setInterval(() => {
        if (this.status !== "online" || !bot.entity) return;
        try {
          let target: typeof bot.entity | null = null;
          if (mode === "mob") {
            target = bot.nearestEntity((e) => {
              if (!e || !e.isValid) return false;
              return e.type === "mob" || e.type === "hostile";
            });
          } else if (mode === "player" && targetName) {
            const playerEntry = Object.values(bot.players).find(
              (p) => p.username.toLowerCase() === targetName,
            );
            target = playerEntry?.entity ?? null;
          }
          if (!target || !target.position) return;
          const dist = bot.entity.position.distanceTo(target.position);
          const eyePos = target.position.offset(0, (target as { height?: number }).height ?? 1.62, 0);
          bot.lookAt(eyePos, true);
          if (dist <= 4) {
            bot.attack(target);
          } else {
            // FIX: cancel any pending forward-release before setting forward again,
            // and track the new timeout so stopTimers() can cancel it.
            if (this.forwardTimer) { clearTimeout(this.forwardTimer); this.forwardTimer = null; }
            bot.setControlState("forward", true);
            this.forwardTimer = setTimeout(() => {
              this.forwardTimer = null;
              try { bot.setControlState("forward", false); } catch {}
            }, 400);
          }
        } catch { /* entity may become invalid mid-tick */ }
      }, 500);

      if (mode === "mob") this.log("info", "⚔️ Attack mode ON — targeting nearest mob");
      else if (mode === "player" && cfg.attackPlayerName)
        this.log("info", `⚔️ Attack mode ON — targeting player: ${cfg.attackPlayerName}`);
    }
  }

  private stopTimers() {
    if (this.uptimeTimer)   { clearInterval(this.uptimeTimer);   this.uptimeTimer = null; }
    if (this.attackTimer)   { clearInterval(this.attackTimer);   this.attackTimer = null; }
    if (this.movementTimer) { clearInterval(this.movementTimer); this.movementTimer = null; }
    // FIX: also cancel the tracked forward-release timeout
    if (this.forwardTimer)  { clearTimeout(this.forwardTimer);   this.forwardTimer = null; }
    this.startTime = null;
    this.stats.uptime = 0;
    this.stats.pos = null;
    this.stats.ping = 0;
  }

  private destroyBot(clearStats: boolean) {
    if (this.bot) {
      try { this.bot.quit(); } catch {}
      this.bot.removeAllListeners();
      this.bot = null;
    }
    this.stopTimers();
    if (clearStats) {
      this.stats = { health: 0, food: 0, ping: 0, players: 0, reconnects: 0, dropped: 0, uptime: 0, pos: null };
    }
  }
}
