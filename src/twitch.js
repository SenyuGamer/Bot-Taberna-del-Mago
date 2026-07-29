import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig, addInspirations } from "./db.js";
import { TEMA, embed, enviarRegistro } from "./utils.js";

// Adaptado de OwlTwitch backend: eventsub.ts + twitch-auth.ts (versión reducida
// para un solo canal: detectar canjes de puntos de canal en el chat de Twitch).

const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";
const TOKEN_FILE = process.env.TWITCH_TOKEN_FILE || "data/twitch-token.json";
const SCOPE_NECESARIO = "channel:read:redemptions";

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN } =
  process.env;

// Regex para reconocer el canje (por defecto cualquier título que diga "inspiraci...")
export const REWARD_REGEX = new RegExp(process.env.TWITCH_REWARD_REGEX || "inspiraci", "i");

// ---------- Gestión de tokens ----------

export function guardarTokens(tokens) {
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch (error) {
    console.error("🦉 No se pudieron guardar los tokens de Twitch:", error.message);
  }
}

function leerTokensGuardados() {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function validarToken(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(VALIDATE_URL, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!res.ok) return null;
    return await res.json(); // { user_id, login, scopes, expires_in, client_id }
  } catch {
    return null;
  }
}

export async function refrescarToken(refreshToken) {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
    });
    const res = await fetch(TOKEN_URL, { method: "POST", body });
    if (!res.ok) {
      console.error(`🦉 No se pudo refrescar el token de Twitch: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return { access_token: data.access_token, refresh_token: data.refresh_token };
  } catch (error) {
    console.error("🦉 Error refrescando token de Twitch:", error.message);
    return null;
  }
}

/**
 * Fuerza la renovación usando el refresh token más reciente conocido
 * (primero el archivo de tokens — donde se guardan las rotaciones — y luego .env).
 * Devuelve los tokens nuevos o null si no se pudo renovar.
 */
export async function renovarTokenGuardado() {
  const refresh = leerTokensGuardados()?.refresh_token || TWITCH_REFRESH_TOKEN;
  if (!refresh) {
    console.error("🦉 No hay refresh token disponible. Usa /sincronizar twitch de nuevo.");
    return null;
  }
  const nuevos = await refrescarToken(refresh);
  if (nuevos) {
    guardarTokens(nuevos);
    console.log("🦉 Token de Twitch renovado y guardado.");
  }
  return nuevos;
}

/** Obtiene un access token válido (+usuario). Devuelve null si no hay credenciales válidas. */
async function obtenerCredenciales() {
  const guardados = leerTokensGuardados();
  let tokens = {
    access_token: TWITCH_ACCESS_TOKEN || guardados?.access_token || null,
    refresh_token: TWITCH_REFRESH_TOKEN || guardados?.refresh_token || null,
  };

  let info = await validarToken(tokens.access_token);

  if (!info && tokens.refresh_token) {
    console.log("🦉 Access token de Twitch caducado, refrescando...");
    const nuevos = await refrescarToken(tokens.refresh_token);
    if (nuevos) {
      tokens = nuevos;
      guardarTokens(tokens);
      info = await validarToken(tokens.access_token);
    }
  }

  if (!info) return null;
  console.log(`🦉 Token de Twitch válido para @${info.login} (expira en ${Math.round(info.expires_in / 3600)}h).`);

  if (!info.scopes?.includes(SCOPE_NECESARIO)) {
    console.error(`❌ El token de Twitch no tiene el scope '${SCOPE_NECESARIO}'. Genera uno nuevo con /sincronizar twitch.`);
    return null;
  }

  return { accessToken: tokens.access_token, userId: info.user_id, login: info.login, vidaSegundos: info.expires_in };
}

// ---------- Flujo OAuth (compartido por /sincronizar twitch y npm run twitch-auth) ----------

/**
 * Levanta un servidor local temporal para recibir el callback de OAuth de Twitch.
 * Devuelve { authUrl, redirectUri, promesa } — `promesa` resuelve con los tokens
 * cuando el canal autoriza, o rechaza si hay error/timeout.
 */
export function iniciarFlujoOAuth({ port = Number(process.env.TWITCH_AUTH_PORT || 3456), timeoutMs = 5 * 60_000 } = {}) {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error("Faltan TWITCH_CLIENT_ID y/o TWITCH_CLIENT_SECRET en .env");
  }

  const redirectUri = `http://localhost:${port}/callback`;
  const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authUrl.search = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE_NECESARIO,
    force_verify: "false",
  });

  let server;
  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    try { server?.close(); } catch {}
  };

  const promesa = new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Nada por aquí. Vuelve a Discord.");
        return;
      }

      const code = url.searchParams.get("code");
      const errorDesc = url.searchParams.get("error_description");
      if (!code) {
        res.writeHead(400);
        res.end(`Error de autorización: ${errorDesc ?? "sin código"}`);
        cleanup();
        reject(new Error(errorDesc ?? "Twitch no devolvió el código de autorización."));
        return;
      }

      try {
        const body = new URLSearchParams({
          client_id: TWITCH_CLIENT_ID,
          client_secret: TWITCH_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        });
        const tokenRes = await fetch(TOKEN_URL, { method: "POST", body });
        const data = await tokenRes.json();

        if (!tokenRes.ok) {
          res.writeHead(500);
          res.end("Error obteniendo el token. Vuelve a Discord.");
          cleanup();
          reject(new Error(`Twitch respondió ${tokenRes.status}: ${data.message ?? "error desconocido"}`));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>✅ Twitch sincronizado</h1><p>Ya puedes cerrar esta pestaña y volver a Discord.</p>");
        cleanup();
        resolve({ access_token: data.access_token, refresh_token: data.refresh_token });
      } catch (error) {
        try { res.writeHead(500); res.end("Error de red."); } catch {}
        cleanup();
        reject(new Error(`Error de red hablando con Twitch: ${error.message}`));
      }
    });

    server.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo abrir el puerto ${port}: ${error.message}`));
    });

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Se agotó el tiempo de espera (${Math.round(timeoutMs / 60000)} min). Vuelve a usar el comando.`));
    }, timeoutMs);

    server.listen(port);
  });

  // Evita un "unhandledRejection" fatal si el rechazo ocurre antes de que el
  // consumidor (comando o CLI) adjunte su await. El rechazo sigue propagándose.
  promesa.catch(() => {});

  return { authUrl: authUrl.href, redirectUri, promesa };
}

// ---------- EventSub WebSocket ----------

let wsActual = null;
let keepaliveTimer = null;
let renovacionTimer = null;
let detenido = false;
let clienteActual = null;
let intentosRenovacion = 0;
const MAX_INTENTOS_RENOVACION = 2;

/** Detiene la conexión con Twitch (sin reconexión automática). */
export function detenerTwitch() {
  detenido = true;
  clearTimeout(keepaliveTimer);
  clearTimeout(renovacionTimer);
  if (wsActual) {
    const ws = wsActual;
    wsActual = null;
    try { ws.close(); } catch {}
  }
}

/** Renueva el token y reinicia la integración con las credenciales nuevas. */
async function renovarYAReconectar() {
  if (!clienteActual) return;
  const nuevos = await renovarTokenGuardado();
  if (!nuevos) {
    console.error("❌ No se pudo renovar el token de Twitch. Usa /sincronizar twitch o reinicia el bot.");
    return;
  }
  await iniciarTwitch(clienteActual);
}

/**
 * Programa la renovación automática del token ~30 min antes de que caduque
 * (mínimo 1 min). Tras renovar, iniciarTwitch vuelve a programar el siguiente ciclo.
 */
function programarRenovacion(client, segundosVida) {
  clearTimeout(renovacionTimer);
  clienteActual = client;
  const enSegundos = Math.max(segundosVida - 1800, 60);
  const enMinutos = Math.round(enSegundos / 60);
  console.log(`🦉 Renovación automática del token programada en ~${enMinutos} min.`);
  renovacionTimer = setTimeout(() => {
    console.log("🦉 Renovando token de Twitch automáticamente (antes de que caduque)...");
    renovarYAReconectar();
  }, enSegundos * 1000);
}

async function crearSuscripcionCanjes(sessionId, broadcasterId, accessToken) {
  const res = await fetch(SUBSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: "websocket", session_id: sessionId },
    }),
  });
  if (res.ok) {
    intentosRenovacion = 0;
    console.log("🦉 Suscrito a canjes de puntos del canal (EventSub).");
    return;
  }

  if (res.status === 401) {
    // Token muerto (caducó y Twitch lo rechaza): renovar y reconectar una vez
    console.warn("🦉 Twitch rechazó el token al suscribirse (401). Renovando y reconectando...");
    if (intentosRenovacion < MAX_INTENTOS_RENOVACION) {
      intentosRenovacion++;
      renovarYAReconectar();
    } else {
      console.error("❌ Demasiados intentos de renovación fallidos. Usa /sincronizar twitch de nuevo.");
    }
    return;
  }

  console.error(`❌ No se pudo suscribir a los canjes: ${res.status} ${await res.text()}`);
}

/**
 * Conecta al WebSocket de EventSub y escucha canjes. Se reconecta solo.
 * @param {(canje: {user_name: string, user_login: string, reward_title: string, user_input: string}) => void} onCanje
 */
function conectarEventSub(accessToken, broadcasterId, onCanje, url = EVENTSUB_WS_URL) {
  const ws = new WebSocket(url);
  wsActual = ws;

  const reiniciarWatchdog = (segundos) => {
    clearTimeout(keepaliveTimer);
    // Si Twitch no manda nada en keepalive + margen, asumimos conexión muerta
    keepaliveTimer = setTimeout(() => {
      console.warn("🦉 EventSub sin actividad, reconectando...");
      ws.close();
    }, (segundos + 10) * 1000);
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");
    } catch {
      return;
    }
    const { metadata, payload } = msg;
    reiniciarWatchdog(payload?.session?.keepalive_timeout_seconds ?? 20);

    if (metadata.message_type === "session_welcome") {
      console.log(`🦉 EventSub conectado (sesión ${payload.session.id}).`);
      await crearSuscripcionCanjes(payload.session.id, broadcasterId, accessToken);
    }

    if (metadata.message_type === "session_reconnect") {
      console.log("🦉 Twitch pidió reconexión de EventSub...");
      conectarEventSub(accessToken, broadcasterId, onCanje, payload.session.reconnect_url);
      ws.close();
    }

    if (metadata.message_type === "revocation") {
      console.error(`❌ Twitch revocó la suscripción: ${JSON.stringify(payload.subscription?.status)}`);
    }

    if (
      metadata.message_type === "notification" &&
      payload.subscription.type === "channel.channel_points_custom_reward_redemption.add"
    ) {
      const evt = payload.event;
      const canje = {
        user_name: evt.user_name,
        user_login: evt.user_login,
        reward_title: evt.reward?.title ?? "(sin título)",
        user_input: evt.user_input ?? "",
      };
      console.log(`🦉 Canje en Twitch: ${canje.user_name} → "${canje.reward_title}"`);
      if (REWARD_REGEX.test(canje.reward_title)) {
        onCanje(canje);
      }
    }
  };

  ws.onerror = (error) => console.error("🦉 Error en WebSocket de EventSub:", error.message ?? error);
  ws.onclose = () => {
    clearTimeout(keepaliveTimer);
    // Solo reconecta si es la conexión vigente y no fue un cierre voluntario
    if (!detenido && url === EVENTSUB_WS_URL && wsActual === ws) {
      console.log("🦉 EventSub desconectado. Reintentando en 10s...");
      setTimeout(() => {
        if (!detenido && wsActual === ws) conectarEventSub(accessToken, broadcasterId, onCanje);
      }, 10_000);
    }
  };
}

// ---------- Lógica del canje ----------

async function manejarCanje(client, canje) {
  const guildId = process.env.GUILD_ID;
  if (!guildId) {
    console.warn("🦉 Canje detectado pero falta GUILD_ID en .env para saber a qué servidor sumar.");
    return;
  }
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    console.error("🦉 No se encontró el servidor de Discord (revisa GUILD_ID).");
    return;
  }

  const { dm_id } = getConfig(guildId);
  if (!dm_id) {
    console.warn("🦉 Canje recibido pero no hay DM asignado (/dm asignar).");
    await enviarRegistro(
      guild,
      embed(TEMA.color.error, `⚠️ **${canje.user_name}** canjeó **${canje.reward_title}** en Twitch, pero la taberna no tiene DM asignado. Un admin puede usar \`/dm asignar\`.`, "✨ Canje de Twitch")
    );
    return;
  }

  const total = addInspirations(guildId, dm_id, 1);
  console.log(`✨ +1 inspiración al DM (<@${dm_id}>, total ${total}) por canje de ${canje.user_name}.`);
  await enviarRegistro(
    guild,
    embed(
      TEMA.color.inspiracion,
      `✨ **${canje.user_name}** canjeó **${canje.reward_title}** en Twitch.\nEl búho mensajero entrega **+1 inspiración heroica** al DM <@${dm_id}>.\nTotal del DM: **${total}** ${TEMA.emoji.inspiracion}`,
      "✨ Canje de Twitch"
    )
  );
}

// ---------- Punto de entrada ----------

/**
 * Inicia (o reinicia) la integración con Twitch. Devuelve las credenciales
 * vigentes ({ login, userId, accessToken }) o null si está desactivada/falló.
 */
export async function iniciarTwitch(client) {
  if (!TWITCH_CLIENT_ID || !(TWITCH_ACCESS_TOKEN || TWITCH_REFRESH_TOKEN || leerTokensGuardados())) {
    console.log("🦉 Integración con Twitch desactivada (sin credenciales). Usa /sincronizar twitch.");
    return null;
  }
  if (!TWITCH_CLIENT_SECRET && TWITCH_REFRESH_TOKEN) {
    console.warn("🦉 Falta TWITCH_CLIENT_SECRET: si el access token caduca no podrá refrescarse.");
  }

  try {
    const credenciales = await obtenerCredenciales();
    if (!credenciales) {
      console.error("❌ No se obtuvieron credenciales válidas de Twitch. Usa /sincronizar twitch.");
      return null;
    }
    // Reinicio limpio por si ya había una conexión con tokens anteriores
    detenerTwitch();
    detenido = false;
    console.log(`🦉 Escuchando canjes del canal de @${credenciales.login}...`);
    conectarEventSub(credenciales.accessToken, credenciales.userId, (canje) => manejarCanje(client, canje));
    programarRenovacion(client, credenciales.vidaSegundos);
    return credenciales;
  } catch (error) {
    console.error("❌ No se pudo iniciar la integración con Twitch:", error);
    return null;
  }
}
