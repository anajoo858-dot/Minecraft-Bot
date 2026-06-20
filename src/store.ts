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

function readJson<T>(file: string, defaultVal: T): T {
  const fp = path.join(dataDir, file);
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8")) as T;
  } catch {
    return defaultVal;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
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

export function getConfig(): BotConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<BotConfig>>("config.json", {}) };
}

export function saveConfig(cfg: Partial<BotConfig>): BotConfig {
  const merged = { ...DEFAULT_CONFIG, ...readJson<Partial<BotConfig>>("config.json", {}), ...cfg };
  writeJson("config.json", merged);
  return merged;
}

export function getPassword(host: string, port: number): string | null {
  const passwords = readJson<Record<string, string>>("passwords.json", {});
  return passwords[`${host}:${port}`] ?? null;
}

export function getOrCreatePassword(host: string, port: number): string {
  const passwords = readJson<Record<string, string>>("passwords.json", {});
  const key = `${host}:${port}`;
  if (!passwords[key]) {
    passwords[key] = crypto.randomBytes(10).toString("hex");
    writeJson("passwords.json", passwords);
  }
  return passwords[key];
}
