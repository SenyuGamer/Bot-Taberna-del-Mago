import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { PermissionsBitField } from "discord.js";
import { Mixer, clampVolumen } from "./mixer.js";
import { crearPipeline } from "./pipeline.js";
import { crearEncoderOpus } from "./encoderOpus.js";
import { setCanalDjinni, getCanalDjinni } from "../db.js";

// Gestiona las sesiones de voz: una conexión por servidor (guild).
// Fuentes: "djinni:*" (espejo de Djinni) y "manual:*" (de /musica url).
// Multi-canal: un guild = un canal; varios guilds en paralelo, sin problema.

const sesiones = new Map(); // guildId -> SesionDeVoz
const fabricaPipelines = { crearPipeline }; // indirección para pruebas
export function _setFabricaPipelines(f) { fabricaPipelines.crearPipeline = f; }

const MS_SILENCIO_PARA_SALIR = 5 * 60 * 1000;

export function getSesion(guildId) {
  return sesiones.get(guildId) ?? null;
}

export function listarSesiones() {
  return [...sesiones.entries()].map(([guildId, s]) => ({ guildId, canalId: s.canalId, fuentes: s.fuentes.size, pausado: s.mixer?.pausado ?? false }));
}

/** Une (o mueve) el bot al canal de voz indicado y crea la sesión. */
export async function unir(guild, canal, clientId) {
  parar(guild.id); // limpieza si había una sesión previa

  const perms = canal.permissionsFor(clientId);
  const necesarios = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak];
  const faltantes = necesarios.filter((p) => !perms?.has(p));
  if (faltantes.length > 0) {
    const nombres = faltantes.map((p) => Object.entries(PermissionsBitField.Flags).find(([, v]) => v === p)?.[0] ?? String(p));
    throw new Error(`Al bot le faltan permisos en <#${canal.id}>: ${nombres.join(", ")}. Revísalos en Configuración del canal > Permisos.`);
  }

  const connection = joinVoiceChannel({
    channelId: canal.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true, // ensordecido: como hacen los bots de música (sin indicador de "escuchando")
    selfMute: false, // sigue hablando: el audio se transmite igualmente
    daveEncryption: true, // Discord exige DAVE (close 4017). En RISC-V se usa el build WASM de davey.
  });

  const player = createAudioPlayer();
  const mixer = new Mixer();
  // Encodemos el PCM mezclado a ogg/opus con ffmpeg (RISC-V: opusscript crashea).
  const ffEnc = crearEncoderOpus({ onError: (e) => console.error(`🎵 ${e.message}`) });
  mixer.salida.pipe(ffEnc.stdin);
  const recurso = createAudioResource(ffEnc.stdout, { inputType: StreamType.OggOpus });
  player.play(recurso);
  connection.subscribe(player);

  connection.on("stateChange", (_viejo, nuevo) => {
    console.log(`🎵 Voz (${guild.name}): ${nuevo.status}`);
  });
  connection.on("error", (error) => {
    console.error(`🎵 Error de conexión de voz en ${guild.name}:`, error.message, error);
  });
  connection.on("debug", (msg) => {
    console.log(`🎵 Voz debug (${guild.name}):`, msg);
  });
  player.on("error", (error) => {
    console.error(`🎵 Error del reproductor en ${guild.name}:`, error.message);
  });

  const sesion = {
    guildId: guild.id,
    canalId: canal.id,
    connection,
    player,
    mixer,
    recurso,
    fuentes: new Map(), // id -> {id, url, tipo, loop, volumen, userId, pipeline}
    temporizadorVacio: null,
  };
  sesiones.set(guild.id, sesion);
  setCanalDjinni(guild.id, canal.id);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    parar(guild.id);
    throw new Error("No pude conectarme al canal de voz (¿permiso de Conectar/Hablar para el bot?).");
  }
  return sesion;
}

/** Desconecta y limpia la sesión del guild. Devuelve si existía. */
export function parar(guildId) {
  const s = sesiones.get(guildId);
  if (!s) return false;
  for (const id of s.fuentes.keys()) _quitarFuenteDeSesion(s, id);
  clearTimeout(s.temporizadorVacio);
  s.mixer.detener();
  try { s.player.stop(); } catch {}
  try { s.connection.destroy(); } catch {}
  sesiones.delete(guildId);
  return true;
}

export function canalGuardado(guildId) {
  return getCanalDjinni(guildId);
}

function _quitarFuenteDeSesion(s, id) {
  const fuente = s.fuentes.get(id);
  if (!fuente) return;
  try { fuente.pipeline?.detener(); } catch {}
  s.fuentes.delete(id);
  s.mixer.quitarFuente(id);
}

export function quitarFuente(guildId, id) {
  const s = sesiones.get(guildId);
  if (!s) return false;
  const existia = s.fuentes.has(id);
  _quitarFuenteDeSesion(s, id);
  return existia;
}

/**
 * Añade una fuente (YouTube u otra URL que entienda yt-dlp).
 * Devuelve { promesa } — `promesa` resuelve al primer audio o rechaza con el error.
 */
export function agregarFuente(guildId, { id, url, volumen = 1, loop = false, loopDelayMs, tipo = "djinni", userId = null, nombre = "", cancionId = null, onError }) {
  const s = sesiones.get(guildId);
  if (!s) return null;
  if (s.fuentes.has(id)) _quitarFuenteDeSesion(s, id);

  s.mixer.agregarFuente(id, clampVolumen(volumen));
  let resolvePrimer, rejectPrimer;
  const promesa = new Promise((res, rej) => { resolvePrimer = res; rejectPrimer = rej; });

  const pipeline = fabricaPipelines.crearPipeline({
    url,
    loop,
    loopDelayMs,
    onDatos: (bytes) => {
      s.mixer.empujar(id, bytes);
    },
    onFin: () => {
      if (!loop) _quitarFuenteDeSesion(s, id);
    },
    onError: (error) => {
      _quitarFuenteDeSesion(s, id);
      rejectPrimer(error);
      onError?.(error);
    },
  });

  s.fuentes.set(id, { id, url, tipo, loop, volumen: clampVolumen(volumen), userId, nombre, cancionId, pipeline });
  pipeline.esperarPrimerAudio?.().then(resolvePrimer).catch(rejectPrimer);

  return { promesa };
}

export function quitarFuentesManuales(guildId, { soloDe = null } = {}) {
  const s = sesiones.get(guildId);
  if (!s) return 0;
  let quitadas = 0;
  for (const [id, fuente] of [...s.fuentes.entries()]) {
    if (fuente.tipo !== "manual") continue;
    if (soloDe && fuente.userId !== soloDe) continue;
    _quitarFuenteDeSesion(s, id);
    quitadas++;
  }
  return quitadas;
}

// ---------- Menú de canciones del DM (panel Owlbear → bot) ----------

/**
 * Reproduce una canción del menú en la sesión. Devuelve null si no hay sesión,
 * o { promesa } (resuelve al primer audio, rechaza con el error).
 */
export function reproducirCancionMenu(guildId, { id = null, url, nombre = "", loop = false }) {
  const s = sesiones.get(guildId);
  if (!s) return null;

  // El menú reproduce una canción a la vez (id estable "menu:activa").
  const fuenteId = "menu:activa";
  return agregarFuente(guildId, {
    id: fuenteId,
    url,
    volumen: 1,
    loop,
    nombre,
    tipo: "menu",
    cancionId: id,
    onError: (e) => console.error(`🎵 Canción del menú falló:`, e.message),
  });
}

/** Detiene la canción del menú si estaba sonando. */
export function pararCancionMenu(guildId) {
  const s = sesiones.get(guildId);
  if (!s) return false;
  if (!s.fuentes.has("menu:activa")) return false;
  _quitarFuenteDeSesion(s, "menu:activa");
  return true;
}

/** Estado de la canción del menú en la sesión (para el panel). */
export function estadoCancionMenu(guildId) {
  const s = sesiones.get(guildId);
  const fuente = s?.fuentes.get("menu:activa");
  if (!fuente) return { sonando: false, url: null, nombre: null, cancionId: null };
  return { sonando: true, url: fuente.url, nombre: fuente.nombre, cancionId: fuente.cancionId ?? null };
}

// ---------- Salida automática si el canal se queda vacío ----------

/** Si el canal de la sesión se queda sin humanos, programa la retirada (5 min). */
export function programarSalidaSiVacio(guild, client) {
  const s = sesiones.get(guild.id);
  if (!s) return;
  const canal = guild.channels.cache.get(s.canalId);
  if (!canal) return;
  const humanos = canal.members?.filter((m) => !m.user.bot).size ?? 1;

  if (humanos === 0 && !s.temporizadorVacio) {
    s.temporizadorVacio = setTimeout(() => {
      console.log(`🎵 Canal vacío en ${guild.name}: me retiro de la llamada.`);
      parar(guild.id);
    }, MS_SILENCIO_PARA_SALIR);
    s.temporizadorVacio.unref?.();
  } else if (humanos > 0 && s.temporizadorVacio) {
    clearTimeout(s.temporizadorVacio);
    s.temporizadorVacio = null;
  }
}

// ---------- Solo para pruebas (sin Discord ni voz real) ----------
export function _seedSesionPrueba(guildId) {
  const sesion = {
    guildId,
    canalId: "canal-prueba",
    connection: { destroy: () => {} },
    player: { stop: () => {} },
    mixer: new Mixer(),
    fuentes: new Map(),
    temporizadorVacio: null,
  };
  sesiones.set(guildId, sesion);
  return sesion;
}

export function _limpiarSesionesPrueba() {
  for (const g of [...sesiones.keys()]) parar(g);
}
