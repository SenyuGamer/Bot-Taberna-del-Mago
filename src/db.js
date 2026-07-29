import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = process.env.DB_PATH || "data/taberna.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS stars (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    tipo     TEXT NOT NULL CHECK (tipo IN ('normal', 'negra')),
    cantidad INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, tipo)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS inspirations (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    cantidad INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id       TEXT PRIMARY KEY,
    dm_id          TEXT,
    log_channel_id TEXT
  )
`);

// ---------- Estrellitas ----------

const getStarsStmt = db.prepare(
  "SELECT cantidad FROM stars WHERE guild_id = ? AND user_id = ? AND tipo = ?"
);
const upsertStarsStmt = db.prepare(`
  INSERT INTO stars (guild_id, user_id, tipo, cantidad)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (guild_id, user_id, tipo) DO UPDATE SET cantidad = excluded.cantidad
`);
const topStarsStmt = db.prepare(
  "SELECT user_id, cantidad FROM stars WHERE guild_id = ? AND tipo = ? AND cantidad > 0 ORDER BY cantidad DESC LIMIT 10"
);

export function getStars(guildId, userId, tipo) {
  const row = getStarsStmt.get(guildId, userId, tipo);
  return row ? row.cantidad : 0;
}

/** Suma (o resta con delta negativo) estrellitas. Devuelve el nuevo total o null si quedaría en negativo. */
export function addStars(guildId, userId, tipo, delta) {
  const actual = getStars(guildId, userId, tipo);
  const nuevo = actual + delta;
  if (nuevo < 0) return null;
  upsertStarsStmt.run(guildId, userId, tipo, nuevo);
  return nuevo;
}

export function topStars(guildId, tipo) {
  return topStarsStmt.all(guildId, tipo);
}

// ---------- Inspiraciones heroicas ----------

const getInspStmt = db.prepare(
  "SELECT cantidad FROM inspirations WHERE guild_id = ? AND user_id = ?"
);
const upsertInspStmt = db.prepare(`
  INSERT INTO inspirations (guild_id, user_id, cantidad)
  VALUES (?, ?, ?)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET cantidad = excluded.cantidad
`);

export function getInspirations(guildId, userId) {
  const row = getInspStmt.get(guildId, userId);
  return row ? row.cantidad : 0;
}

/** Suma (o resta con delta negativo) inspiraciones. Devuelve el nuevo total o null si quedaría en negativo. */
export function addInspirations(guildId, userId, delta) {
  const actual = getInspirations(guildId, userId);
  const nuevo = actual + delta;
  if (nuevo < 0) return null;
  upsertInspStmt.run(guildId, userId, nuevo);
  return nuevo;
}

// ---------- Configuración del servidor ----------

const getConfigStmt = db.prepare(
  "SELECT dm_id, log_channel_id FROM guild_config WHERE guild_id = ?"
);
const ensureConfigStmt = db.prepare(
  "INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)"
);
const setDmStmt = db.prepare(
  "UPDATE guild_config SET dm_id = ? WHERE guild_id = ?"
);
const setLogChannelStmt = db.prepare(
  "UPDATE guild_config SET log_channel_id = ? WHERE guild_id = ?"
);

export function getConfig(guildId) {
  ensureConfigStmt.run(guildId);
  return getConfigStmt.get(guildId);
}

export function setDm(guildId, dmId) {
  ensureConfigStmt.run(guildId);
  setDmStmt.run(dmId, guildId);
}

export function setLogChannel(guildId, channelId) {
  ensureConfigStmt.run(guildId);
  setLogChannelStmt.run(channelId, guildId);
}
