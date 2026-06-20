import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const dataDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function sessionDir(sessionId: string): string {
  const dir = path.join(dataDir, "sessions", sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string, defaultVal: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return defaultVal;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export interface BotConfig {
  host: string;
  port: number;
  username: string;
  version: string;
  autoReconnect: boolean;
  randomMovement: boolean;
  autoDrop: boolean;
  knockbackEvasion: boolean;
  autoAuth: boolean;
  attackMode: "off" | "mob" | "player";
  attackPlayerName: string;
  proxyEnabled: boolean;
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
}

const DEFAULT_CONFIG: BotConfig = {
  host: "",
  port: 25565,
  username: "BotPlayer",
  version: "1.21.1",
  autoReconnect: true,
  randomMovement: true,
  autoDrop: true,
  knockbackEvasion: true,
  autoAuth: true,
  attackMode: "off",
  attackPlayerName: "",
  proxyEnabled: false,
  proxyHost: "",
  proxyPort: 1080,
  proxyUsername: "",
  proxyPassword: "",
};

export function getConfig(sessionId: string): BotConfig {
  const file = path.join(sessionDir(sessionId), "config.json");
  return { ...DEFAULT_CONFIG, ...readJson<Partial<BotConfig>>(file, {}) };
}

export function saveConfig(sessionId: string, cfg: Partial<BotConfig>): BotConfig {
  const file = path.join(sessionDir(sessionId), "config.json");
  const merged = { ...DEFAULT_CONFIG, ...readJson<Partial<BotConfig>>(file, {}), ...cfg };
  writeJson(file, merged);
  return merged;
}

export function getPassword(sessionId: string, host: string, port: number): string | null {
  const file = path.join(sessionDir(sessionId), "passwords.json");
  const passwords = readJson<Record<string, string>>(file, {});
  return passwords[`${host}:${port}`] ?? null;
}

export function getOrCreatePassword(sessionId: string, host: string, port: number): string {
  const file = path.join(sessionDir(sessionId), "passwords.json");
  const passwords = readJson<Record<string, string>>(file, {});
  const key = `${host}:${port}`;
  if (!passwords[key]) {
    passwords[key] = crypto.randomBytes(10).toString("hex");
    writeJson(file, passwords);
  }
  return passwords[key];
}
