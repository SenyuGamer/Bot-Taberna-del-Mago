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

// ---------- Sesiones de música (DJGambit → voz) ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS djgambit_sessions (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const getCanalDjgambitStmt = db.prepare(
  "SELECT channel_id FROM djgambit_sessions WHERE guild_id = ?"
);
const setCanalDjgambitStmt = db.prepare(`
  INSERT INTO djgambit_sessions (guild_id, channel_id, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at
`);

/** Canal de voz usado por última vez con música (para re-sincronizar rápido). */
export function getCanalDjgambit(guildId) {
  const row = getCanalDjgambitStmt.get(guildId);
  return row ? row.channel_id : null;
}

export function setCanalDjgambit(guildId, channelId) {
  setCanalDjgambitStmt.run(guildId, channelId, new Date().toISOString());
}

// ---------- Menú global de canciones del DM ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_canciones (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre     TEXT NOT NULL,
    icono      TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL,
    loop       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`);

const getMenuStmt = db.prepare("SELECT id, nombre, icono, url, loop FROM menu_canciones ORDER BY id ASC");
const getCancionStmt = db.prepare("SELECT id, nombre, icono, url, loop FROM menu_canciones WHERE id = ?");
const insertCancionStmt = db.prepare(
  "INSERT INTO menu_canciones (nombre, icono, url, loop, created_at) VALUES (?, ?, ?, ?, ?)"
);
const deleteCancionStmt = db.prepare("DELETE FROM menu_canciones WHERE id = ?");

export function listarCancionesMenu() {
  return getMenuStmt.all().map((c) => ({ ...c, loop: !!c.loop }));
}

export function getCancionMenu(id) {
  const c = getCancionStmt.get(id);
  return c ? { ...c, loop: !!c.loop } : null;
}

export function agregarCancionMenu({ nombre, icono = "", url, loop = false }) {
  const info = insertCancionStmt.run(nombre, icono, url, loop ? 1 : 0, new Date().toISOString());
  return getCancionMenu(info.lastInsertRowid);
}

export function borrarCancionMenu(id) {
  return deleteCancionStmt.run(id).changes > 0;
}

// ---------- Vínculos del panel Owlbear → guild ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS djgambit_links (
    token      TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const getLinkStmt = db.prepare("SELECT guild_id FROM djgambit_links WHERE token = ?");
const setLinkStmt = db.prepare(`
  INSERT INTO djgambit_links (token, guild_id, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (token) DO UPDATE SET guild_id = excluded.guild_id, updated_at = excluded.updated_at
`);

/** Devuelve el guild_id vinculado a un token del panel, o null. */
export function getGuildPorToken(token) {
  const row = getLinkStmt.get(token);
  return row ? row.guild_id : null;
}

/** Vincula un token del panel Owlbear a un guild de Discord. */
export function setGuildPorToken(token, guildId) {
  setLinkStmt.run(token, guildId, new Date().toISOString());
}
