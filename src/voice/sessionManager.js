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
    selfDeaf: false,
    selfMute: false,
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
export function agregarFuente(guildId, { id, url, volumen = 1, loop = false, loopDelayMs, tipo = "djinni", userId = null, onError }) {
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

  s.fuentes.set(id, { id, url, tipo, loop, volumen: clampVolumen(volumen), userId, pipeline });
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

// ---------- Espejo de estado Djinni ----------

/**
 * Aplica el estado de Djinni (streams activos, volúmenes, pausa global) a la sesión.
 * Solo se refleja el modo "global" (lo que oyen los jugadores).
 */
export function aplicarEstadoDjinni(guildId, estado) {
  const s = sesiones.get(guildId);
  if (!s || !estado) return { activos: 0, pausado: false };

  const pausadoGlobal = estado.paused === "paused";
  const globalOn = estado.soundOutput !== "local";
  const deseados = new Map(); // id -> {url, volumen}

  if (globalOn && Array.isArray(estado.streams)) {
    for (const stream of estado.streams) {
      if (!stream?.playing || stream.streamMute) continue;
      const volStream = clampVolumen(stream.streamVolume ?? 1);
      const links = Array.isArray(stream.links) ? stream.links : [];
      links.forEach((link, i) => {
        if (!link?.link || link.playing === false || link.mute) return;
        const id = `djinni:${stream.id}:${i}`;
        // Djinni: loop con loop1/loop2 = repetición con retardo aleatorio (se aproxima)
        const min = Math.max(0, Number(link.loopMinSec) || 0);
        const max = Math.max(min, Number(link.loopMaxSec) || 0);
        const loopDelayMs = min === 0 && max === 0
          ? 750
          : () => (min + Math.random() * (max - min)) * 1000;
        deseados.set(id, { url: link.link, volumen: volStream * clampVolumen(link.volume ?? 1), loop: !!link.loop, loopDelayMs });
      });
    }
  }

  // Quitar las fuentes djinni que ya no suenan
  for (const [id] of [...s.fuentes.entries()]) {
    if (id.startsWith("djinni:") && !deseados.has(id)) _quitarFuenteDeSesion(s, id);
  }

  // Añadir o ajustar las que suenan
  for (const [id, deseado] of deseados) {
    const existente = s.fuentes.get(id);
    if (!existente) {
      const creado = agregarFuente(guildId, { id, url: deseado.url, volumen: deseado.volumen, loop: deseado.loop, loopDelayMs: deseado.loopDelayMs, tipo: "djinni",
        onError: (e) => console.error(`🎵 Fuente Djinni ${id} falló:`, e.message) });
      // Evita unhandledRejection cuando el DM cambia de pista y la tubería falla
      creado?.promesa.catch(() => {});
    } else if (Math.abs(existente.volumen - deseado.volumen) > 0.01) {
      existente.volumen = deseado.volumen;
      s.mixer.setVolumen(id, deseado.volumen);
    }
  }

  s.mixer.setPausado(pausadoGlobal);
  return { activos: deseados.size, pausado: pausadoGlobal };
}

/** Aplica el estado a TODAS las sesiones activas (puente sin token: siguen todas al DM). */
export function aplicarEstadoDjinniGlobal(estado) {
  const resumen = [];
  for (const guildId of sesiones.keys()) {
    resumen.push({ guildId, ...aplicarEstadoDjinni(guildId, estado) });
  }
  return resumen;
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
