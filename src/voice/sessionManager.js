import { spawn } from "node:child_process";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  entersState,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
} from "@discordjs/voice";
import { PermissionsBitField } from "discord.js";
import { Mixer, clampVolumen } from "./mixer.js";
import { crearPipeline, existeCache, rutaCache } from "./pipeline.js";
import { crearEncoderOpus } from "./encoderOpus.js";
import { setCanalDjgambit, getCanalDjgambit } from "../db.js";

// Gestiona las sesiones de voz: una conexión por servidor (guild).
// Fuentes: "djgambit:*" (espejo de DJGambit) y "manual:*" (de /musica url).
// Multi-canal: un guild = un canal; varios guilds en paralelo, sin problema.

const sesiones = new Map(); // guildId -> SesionDeVoz
const fabricaPipelines = { crearPipeline }; // indirección para pruebas
export function _setFabricaPipelines(f) { fabricaPipelines.crearPipeline = f; }

const MS_SILENCIO_PARA_SALIR = 5 * 60 * 1000;

// Reconexión automática tras caídas de la conexión de voz (DAVE/red).
// Máximo 3 intentos por ventana de 10 min; si sigue cayéndose, se para.
const MAX_RECONEXIONES = 3;
const MS_VENTANA_RECONEXION = 10 * 60 * 1000;

const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const YTDLP_DURACION = process.env.YTDLP_PATH || "yt-dlp";
const CACHE_DIR = process.env.MUSIC_CACHE_DIR || "data/music-cache";

// Presencia del bot mientras suena música del menú: lo registra el bridge.
let onCambioSonando = null;
export function setOnCambioSonando(fn) { onCambioSonando = fn; }

/**
 * Crea un handler de cierre del encoder opus reutilizable.
 * Tanto la creación inicial como _reemplazarEncoder() usan la misma lógica.
 */
function _crearHandlerCierreEncoder(sesion, miEncoder) {
  return (code) => {
    const guildId = sesion.guildId;
    if (sesiones.get(guildId) !== sesion) return; // sesión ya cerrada
    if (sesion.ffEnc !== miEncoder) return; // encoder ya fue reemplazado
    if (sesion._reemplazandoEncoder) return; // swap en curso, ignorar
    if (code === 0) return; // cierre limpio (p. ej. al detener)
    if (sesion.recargasEncoder >= 5) {
      console.error(`🎵 Encoder opus se cerró ${sesion.recargasEncoder} veces; parando sesión de ${sesion.guild?.name ?? guildId}.`);
      parar(guildId);
      return;
    }
    _reemplazarEncoder(sesion, `cierre inesperado code=${code}`);
  };
}

/**
 * Reemplaza el encoder opus de la sesión de forma limpia:
 * 1. Desconecta (unpipe) el mixer del encoder viejo
 * 2. Mata el proceso viejo
 * 3. Crea un encoder nuevo y lo conecta al mixer
 * 4. Crea un AudioResource nuevo y lo reproduce en el player
 * Evita las carreras con el handler close del encoder viejo.
 */
function _reemplazarEncoder(sesion, motivo) {
  const nombre = sesion.guild?.name ?? sesion.guildId;
  sesion.recargasEncoder++;
  console.log(`🎵 Reemplazando encoder (${motivo}, #${sesion.recargasEncoder}) en ${nombre}`);

  const viejoEnc = sesion.ffEnc;
  // 1. Marcar swap en curso para que el handler close del viejo no interfiera
  sesion._reemplazandoEncoder = true;
  // 2. Desconectar el mixer del encoder viejo ANTES de matarlo
  try { sesion.mixer.salida.unpipe(viejoEnc.stdin); } catch {}
  // 3. Matar el proceso viejo
  try { viejoEnc.kill("SIGTERM"); } catch {}

  // 4. Crear encoder nuevo
  const ffNuevo = crearEncoderOpus({ onError: (e) => console.error(`🎵 ${e.message}`) });
  sesion.ffEnc = ffNuevo;
  sesion._reemplazandoEncoder = false;

  // 5. Diagnóstico del nuevo encoder
  ffNuevo.stdout.on("end", () => console.log(`🎵 Encoder stdout END (${nombre})`));
  ffNuevo.stdout.on("close", () => console.log(`🎵 Encoder stdout CLOSE (${nombre})`));
  ffNuevo.on("exit", (code, signal) => console.log(`🎵 Encoder proceso EXIT code=${code} signal=${signal} (${nombre})`));

  // 6. Conectar el mixer al encoder nuevo
  try { sesion.mixer.salida.pipe(ffNuevo.stdin); } catch {}

  // 7. Registrar handler close del nuevo encoder (auto-reparación)
  ffNuevo.on("close", _crearHandlerCierreEncoder(sesion, ffNuevo));

  // 8. Crear recurso nuevo y reproducir
  const recursoNuevo = createAudioResource(ffNuevo.stdout, { inputType: StreamType.OggOpus });
  sesion.recurso = recursoNuevo;
  try { sesion.player.play(recursoNuevo); } catch (e) {
    console.error(`🎵 No pude reiniciar el reproductor tras reemplazo:`, e.message);
  }
  console.log(`🎵 Encoder reemplazado OK en ${nombre}`);
}

/**
 * Averigua la duración (ms) de una URL de forma no bloqueante:
 * ffprobe del archivo en caché si existe, o una consulta ligera de yt-dlp.
 */
function _obtenerDuracion(url, cacheDir, alTerminar) {
  const resolver = (ms) => { if (Number.isFinite(ms) && ms > 0) alTerminar(Math.round(ms)); };
  const enCache = existeCache({ url, cacheDir });
  const args = enCache
    ? ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", rutaCache({ url, cacheDir })]
    : ["--no-playlist", "--no-warnings", "--print", "duration", url];
  let proc;
  try {
    proc = spawn(enCache ? FFPROBE : YTDLP_DURACION, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch { return; }
  const tope = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 20_000);
  tope.unref?.();
  let salida = "";
  proc.stdout.on("data", (d) => { if (salida.length < 200) salida += d.toString(); });
  proc.on("error", () => clearTimeout(tope));
  proc.on("close", () => {
    clearTimeout(tope);
    resolver(parseFloat(salida.trim()) * 1000);
  });
}

export function getSesion(guildId) {
  return sesiones.get(guildId) ?? null;
}

export function listarSesiones() {
  return [...sesiones.entries()].map(([guildId, s]) => ({ guildId, canalId: s.canalId, fuentes: s.fuentes.size, pausado: s.mixer?.pausado ?? false }));
}

/**
 * Une (o mueve) el bot al canal de voz indicado y crea la sesión.
 * `usuarioId`/`usuarioNombre`: quien reclama el control del menú. Si otro DM
 * está sonando, se rechaza (veto). Con `{ sinControl: true }` (reconexión
 * automática) se omite el veto y se conserva el control previo.
 */
export async function unir(guild, canal, clientId, usuarioId = null, usuarioNombre = "", { sinControl = false } = {}) {
  const previa = sesiones.get(guild.id);
  if (!sinControl && previa && previa.controlUserId && previa.controlUserId !== usuarioId) {
    const enUso = previa.fuentes.has("menu:activa") || previa.fuentes.has("menu:transicion") || !!previa.menuPlaylist;
    if (enUso) {
      throw new Error(`La música la controla ${previa.controlNombre || `<@${previa.controlUserId}>`}. Espera a que la pare para mover el bot.`);
    }
  }
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

  const player = createAudioPlayer({
    behaviors: {
      // Sin tope de frames perdidos: si el encoder se atasca un momento (RISC-V
      // bajo carga), el reproductor emite SILENCIO y se recupera solo cuando el
      // audio vuelve, en vez de entrar en idle y dejar la sesión muda.
      maxMissedFrames: 2000, // ~40 s de tolerancia antes de rendirse
    },
  });
  const mixer = new Mixer();
  // Encodemos el PCM mezclado a ogg/opus con ffmpeg (RISC-V: opusscript crashea).
  const ffEnc = crearEncoderOpus({ onError: (e) => console.error(`🎵 ${e.message}`) });
  // Diagnóstico: por qué se termina el flujo del encoder (stall vs. proceso muerto).
  ffEnc.stdout.on("end", () => console.log(`🎵 Encoder stdout END (${guild.name})`));
  ffEnc.stdout.on("close", () => console.log(`🎵 Encoder stdout CLOSE (${guild.name})`));
  ffEnc.on("exit", (code, signal) => console.log(`🎵 Encoder proceso EXIT code=${code} signal=${signal} (${guild.name})`));
  mixer.salida.on("end", () => console.log(`🎵 Mixer salida END (${guild.name})`));
  mixer.salida.on("close", () => console.log(`🎵 Mixer salida CLOSE (${guild.name})`));
  mixer.salida.pipe(ffEnc.stdin);
  const recurso = createAudioResource(ffEnc.stdout, { inputType: StreamType.OggOpus });
  player.play(recurso);
  connection.subscribe(player);

  // Diagnóstico: transiciones del reproductor (idle -> playing -> idle).
  player.on("stateChange", (viejo, nuevo) => {
    console.log(`🎵 Reproductor (${guild.name}): ${viejo.status} -> ${nuevo.status}`);
  });
  connection.on("stateChange", (_viejo, nuevo) => {
    console.log(`🎵 Voz (${guild.name}): ${nuevo.status}`);
    if (nuevo.status === VoiceConnectionStatus.Destroyed) {
      // La conexión se cayó/cerró: si hay música sonando intentamos reconectar
      // solos (limita con un contador); si no, limpiamos la sesión.
      if (sesiones.get(guild.id) === sesion) _trasCaida(sesion, "conexión destruida");
    }
  });
  // Manejo explícito de Disconnected: cuando Discord re-clavifica DAVE o migra
  // el voice server (p.ej. al hablar), la conexión pasa por Disconnected antes
  // de reconectar. Si es un cierre permanente (4014/kicked, 4021/replaced,
  // 4022/invalidated), no intentamos reconectar. Para el resto, esperamos a
  // que la librería reconecte sola; si no lo hace en 20 s, destruimos y limpiamos.
  const CODIGOS_NO_RECONECTAR = new Set([4021, 4022]);
  connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
    const razon = newState.reason;
    const closeCode = newState.closeCode;
    console.log(`🎵 Voz (${guild.name}): desconectado — reason=${razon}, closeCode=${closeCode}`);

    if (razon === VoiceConnectionDisconnectReason.WebSocketClose && CODIGOS_NO_RECONECTAR.has(closeCode)) {
      console.log(`🎵 Voz (${guild.name}): desconexión permanente (code ${closeCode}), limpiando sesión.`);
      if (sesiones.get(guild.id) === sesion) parar(guild.id);
      return;
    }

    if (closeCode === 4014) {
      // Diferenciar entre kick manual y reconexión DAVE: si Discord intenta
      // reconectar, el estado cambiará a Signalling o Connecting en menos de 5s.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log(`🎵 Voz (${guild.name}): ignorando 4014 (reconexión en curso).`);
      } catch {
        console.log(`🎵 Voz (${guild.name}): desconexión 4014 real (kick/move), limpiando sesión.`);
        if (sesiones.get(guild.id) === sesion) parar(guild.id);
        return;
      }
    }

    // Para el resto de razones (incluyendo DAVE rekeying al entrar/salir
    // usuarios), la librería intenta reconectar sola (transiciona a
    // Signalling → Connecting → Ready). Esperamos a Ready con un timeout.
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      console.log(`🎵 Voz (${guild.name}): reconectada tras desconexión transitoria.`);
      // DAVE rekeying: el socket UDP puede haberse recreado. El encoder/resource
      // viejos están ligados al socket muerto. Esperamos 500ms a que el nuevo
      // socket se estabilice y entonces recreamos el encoder limpiamente.
      if (sesiones.get(guild.id) === sesion && sesion.fuentes.size > 0) {
        await new Promise(r => { const t = setTimeout(r, 500); t.unref?.(); });
        if (sesiones.get(guild.id) === sesion) {
          _reemplazarEncoder(sesion, "reconexión DAVE");
        }
      }
    } catch {
      console.log(`🎵 Voz (${guild.name}): no pude reconectar tras desconexión (timeout 20 s).`);
      if (sesiones.get(guild.id) === sesion) _trasCaida(sesion, "desconexión sin reconexión");
    }
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
    guild, // para poder reconectar tras una caída
    clientId, // para reconectar tras una caída
    reconexiones: 0,
    ultimaCaida: null,
    _parando: false, // evita re-entrancia en parar()
    _trasCaidando: false, // evita re-entrancia en _trasCaida()
    _reemplazandoEncoder: false, // evita que el handler close del viejo interfiera durante un swap
    controlUserId: null, // DM que controla el menú (quien reprodujo/unió por última vez)
    controlNombre: null,
    connection,
    player,
    mixer,
    recurso,
    ffEnc,
    recargasEncoder: 0,
    fuentes: new Map(), // id -> {id, url, tipo, loop, volumen, userId, pipeline}
    temporizadorVacio: null,
    crossfadeTimer: null,
    menuPlaylist: null, // { categoria, canciones, indice } — playlist por categoría activa
    timeline: null, // { nombre, inicioEn, duracionMs } de la canción del menú sonando
    cacheManual: [], // canciones de /musica url que se muestran en el panel
    currentSection: null, // sección activa para controlar crossfade entre secciones
  };
  if (!sinControl && usuarioId) {
    sesion.controlUserId = usuarioId;
    sesion.controlNombre = usuarioNombre || null;
  } else if (previa?.controlUserId) {
    sesion.controlUserId = previa.controlUserId;
    sesion.controlNombre = previa.controlNombre;
  }
  sesiones.set(guild.id, sesion);
  setCanalDjgambit(guild.id, canal.id);

  // Auto-reparación: si el encoder opus muere (p. ej. "Broken pipe"), lo recargamos
  // sin descolgar la conexión para que la música vuelva sola.
  // Usa la función centralizada _crearHandlerCierreEncoder() que hace unpipe/pipe
  // limpiamente y evita carreras con el handler de reconexión DAVE.
  ffEnc.on("close", _crearHandlerCierreEncoder(sesion, ffEnc));

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
  if (s._parando) return false; // evita re-entrancia cuando Destroyed se dispara síncrono
  s._parando = true;
  try {
    if (s.crossfadeTimer) { clearInterval(s.crossfadeTimer); s.crossfadeTimer = null; }
    for (const id of s.fuentes.keys()) _quitarFuenteDeSesion(s, id);
    clearTimeout(s.temporizadorVacio);
    s.mixer.detener();
    try { s.player.stop(); } catch {}
    try { s.mixer.salida.unpipe(s.ffEnc.stdin); } catch {}
    s._reemplazandoEncoder = true; // evita que el handler close intente recrear
    try { s.ffEnc.kill("SIGTERM"); } catch {}
    try { s.connection.destroy(); } catch {}
    sesiones.delete(guildId);
    return true;
  } finally {
    s._parando = false;
  }
}

// ---------- Reconexión automática tras caídas de la conexión de voz ----------

/**
 * Maneja una caída de la conexión de voz (o un error de cifrado DAVE):
 * reconecta la sesión (hasta MAX_RECONEXIONES por ventana); si se agotaron
 * los intentos o la sesión ya no existe, la limpia para que el próximo play
 * cree una nueva.
 */
function _trasCaida(sesion, motivo) {
  if (sesion._trasCaidando) return; // evita re-entrancia si Destroyed se dispara durante parar()
  sesion._trasCaidando = true;
  try {
    const ahora = Date.now();
    if (sesion.ultimaCaida && ahora - sesion.ultimaCaida > MS_VENTANA_RECONEXION) {
      sesion.reconexiones = 0;
    }
    sesion.ultimaCaida = ahora;
    sesion.reconexiones = (sesion.reconexiones ?? 0) + 1;

    const nombre = sesion.guild?.name ?? sesion.guildId;
    if (sesion.reconexiones <= MAX_RECONEXIONES) {
      console.log(`🎵 Voz (${nombre}): ${motivo}; reconectando (intento ${sesion.reconexiones}/${MAX_RECONEXIONES}).`);
      _reconectarSesion(sesion);
    } else if (sesiones.get(sesion.guildId) === sesion) {
      console.log(`🎵 Voz (${nombre}): ${motivo}; max reconexiones alcanzado, limpiando sesión.`);
      parar(sesion.guildId);
    }
  } finally {
    sesion._trasCaidando = false;
  }
}

/**
 * Recrea la sesión (nueva conexión + player + mixer) y vuelve a añadir las
 * fuentes que estaban sonando, para que la música siga sin intervención.
 */
async function _reconectarSesion(sesion) {
  const { guild, canalId, clientId } = sesion;
  const canal = guild?.channels?.cache?.get(canalId);
  if (!guild || !canal || !clientId) {
    if (sesiones.get(sesion.guildId) === sesion) parar(sesion.guildId);
    return;
  }

  const fuentesPrevias = [...sesion.fuentes.values()].map((f) => ({
    id: f.id, url: f.url, tipo: f.tipo, loop: f.loop, volumen: f.volumen,
    userId: f.userId, nombre: f.nombre, cancionId: f.cancionId,
  }));
  // Si la caída pilló a mitad de un crossfade, restauramos la canción entrante.
  const transicion = fuentesPrevias.find((f) => f.id === "menu:transicion");
  const activa = transicion ?? fuentesPrevias.find((f) => f.id === "menu:activa");
  const menuPlaylist = sesion.menuPlaylist ? { ...sesion.menuPlaylist } : null;
  const reconexiones = sesion.reconexiones;
  const ultimaCaida = sesion.ultimaCaida;
  // Guardar control del DM antes de parar (parar borra la sesión del Map).
  const controlUserId = sesion.controlUserId;
  const controlNombre = sesion.controlNombre;

  parar(sesion.guildId); // limpia la sesión caída (evita bucles por Destroyed)

  try {
    const nueva = await unir(guild, canal, clientId, null, "", { sinControl: true });
    nueva.reconexiones = reconexiones;
    nueva.ultimaCaida = ultimaCaida;
    // Restaurar titularidad del DM que controlaba el menú.
    if (controlUserId) {
      nueva.controlUserId = controlUserId;
      nueva.controlNombre = controlNombre;
    }
    if (activa) {
      _ponerCancionActiva(nueva, { id: activa.cancionId, url: activa.url, nombre: activa.nombre, loop: activa.loop }, 0);
    }
    if (menuPlaylist) nueva.menuPlaylist = menuPlaylist;
    for (const f of fuentesPrevias) {
      if (f.tipo === "menu") continue; // la canción activa ya se restauró
      agregarFuente(nueva.guildId, {
        ...f,
        onError: (e) => console.error(`🎵 Canción manual falló tras reconexión:`, e.message),
      });
    }
    console.log(`🎵 Sesión de ${guild.name} reconectada tras caída de la conexión de voz.`);
  } catch (e) {
    console.error(`🎵 No pude reconectar ${guild.name}:`, e.message);
    if (sesiones.get(sesion.guildId) === sesion) parar(sesion.guildId);
  }
}

/** Reconecta todas las sesiones con audio (p. ej. tras un error DAVE no capturado). */
export function reconectarTodasSesiones() {
  for (const s of [...sesiones.values()]) {
    if (s.fuentes.size > 0) _trasCaida(s, "error de cifrado de voz (DAVE)");
  }
}

export function canalGuardado(guildId) {
  return getCanalDjgambit(guildId);
}

function _quitarFuenteDeSesion(s, id) {
  const fuente = s.fuentes.get(id);
  if (!fuente) return;
  try { fuente.pipeline?.detener(); } catch {}
  s.fuentes.delete(id);
  s.mixer.quitarFuente(id);
  // Mantener cacheManual sincronizado: al quitar una fuente manual, borrarla de la caché del panel.
  if (fuente.tipo === "manual") {
    s.cacheManual = s.cacheManual.filter((c) => c.id !== id);
  }
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
export function agregarFuente(guildId, { id, url, volumen = 1, loop = false, loopDelayMs, tipo = "djgambit", userId = null, nombre = "", cancionId = null, onError, onFin: onFinUsuario }) {
  const s = sesiones.get(guildId);
  if (!s) return null;
  if (s.fuentes.has(id)) _quitarFuenteDeSesion(s, id);

  console.log(`🎵 agregarFuente(${id}, tipo=${tipo}, url=${url?.slice(0, 60)}) en ${s.guild?.name ?? guildId}`);
  // Fuentes manuales (/musica url) y menú (Owlbear) son mutuamente excluyentes:
  // al añadir una fuente manual, paramos el menú; al añadir menú, las manuales se paran arriba.
  if (tipo === "manual") pararCancionMenu(guildId);
  s.mixer.agregarFuente(id, clampVolumen(volumen));
  let resolvePrimer, rejectPrimer;
  const promesa = new Promise((res, rej) => { resolvePrimer = res; rejectPrimer = rej; });

  // Referencia mutable al id: permite renombrar la fuente (crossfade
  // transición → activa) sin perder la conexión con el mixer y los callbacks.
  const _idRef = { value: id };

  let primerChunkLog = false;
  const pipeline = fabricaPipelines.crearPipeline({
    url,
    loop,
    loopDelayMs,
    onDatos: (bytes) => {
      if (!primerChunkLog) {
        primerChunkLog = true;
        console.log(`🎵 Primer chunk PCM de ${_idRef.value}: ${bytes.length} bytes, mixer fuentes=${s.mixer.fuentes.size}, ffEnc alive=${!s.ffEnc.killed}`);
        // Diagnóstico: verificar que el audio fluye 5 s después
        setTimeout(() => {
          console.log(`🎵 Diag 5s: mixer.fuentes=${s.mixer.fuentes.size}, fuentes activas=${[...s.fuentes.keys()]}, ffEnc alive=${!s.ffEnc?.killed}, player=${s.player.state?.status}, underruns=${s.mixer.underruns}, emitidos=${s.mixer._emitidos}`);
        }, 5000).unref?.();
      }
      return s.mixer.empujar(_idRef.value, bytes); // false → el pipeline pausa su ffmpeg
    },
    onFin: () => {
      if (!loop) _quitarFuenteDeSesion(s, _idRef.value);
      onFinUsuario?.();
    },
    onError: (error) => {
      _quitarFuenteDeSesion(s, _idRef.value);
      rejectPrimer(error);
      onError?.(error);
    },
  });
  s.mixer.setStockBajo(id, () => pipeline.reanudar());

  s.fuentes.set(id, { id, url, tipo, loop, volumen: clampVolumen(volumen), userId, nombre, cancionId, pipeline, _idRef });
  pipeline.esperarPrimerAudio?.().then(resolvePrimer).catch(rejectPrimer);

  // Mantener cacheManual sincronizado: las fuentes manuales (/musica url) se muestran en el panel.
  if (tipo === "manual") {
    s.cacheManual = s.cacheManual.filter((c) => c.id !== id);
    s.cacheManual.push({ id, url, nombre: nombre || url, userId });
  }

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

/** Devuelve la caché de canciones manuales del panel (las de /musica url). */
export function getCacheManual(guildId) {
  const s = sesiones.get(guildId);
  return s ? s.cacheManual : [];
}

// ---------- Control por turnos del menú (varios DMs pueden vincular) ----------

/**
 * Devuelve un mensaje de veto si otro DM está sonando el menú, o null si está
 * libre (o lo controla el propio `usuarioId`). El control lo toma quien
 * reproduce/une por última vez y se libera al parar.
 */
function _revisarControl(s, usuarioId) {
  if (!s) return null;
  const enUso = s.fuentes.has("menu:activa") || s.fuentes.has("menu:transicion") || !!s.menuPlaylist;
  if (!enUso || !s.controlUserId || s.controlUserId === usuarioId) return null;
  return `La música la controla ${s.controlNombre || `<@${s.controlUserId}>`}. Espera a que la pare para reproducir.`;
}

export function revisarControl(guildId, usuarioId) {
  return _revisarControl(sesiones.get(guildId), usuarioId);
}

// ---------- Menú de canciones del DM (panel Owlbear → bot) ----------

/**
 * Reproduce una canción del menú en la sesión. Devuelve null si no hay sesión,
 * o { promesa } (resuelve al primer audio, rechaza con el error).
 */
const PASOS_CROSSFADE = 20;

export function reproducirCancionMenu(guildId, { id = null, url, nombre = "", loop = false, crossfadeMs = 0, usuarioId = null, usuarioNombre = "", section = null }) {
  const s = sesiones.get(guildId);
  if (!s) return null;
  const bloqueo = _revisarControl(s, usuarioId);
  if (bloqueo) return { error: bloqueo };
  s.menuPlaylist = null; // una reproducción manual cancela el modo lista (playlist por categoría)
  if (usuarioId) { s.controlUserId = usuarioId; s.controlNombre = usuarioNombre || null; }
  // El menú y las fuentes manuales (/musica url) son mutuamente excluyentes:
  // al reproducir una canción del menú, paramos todas las manuales.
  quitarFuentesManuales(guildId);
  return _ponerCancionActiva(s, { id, url, nombre, loop }, crossfadeMs, section);
}

/** Reproduce una canción concreta del menú y avanza la playlist al acabar. */
function _marcarTimeline(s, { id, url, nombre }) {
  s.timeline = { id, url, nombre, inicioEn: Date.now(), duracionMs: null };
  onCambioSonando?.(nombre);
  _obtenerDuracion(url, CACHE_DIR, (ms) => {
    if (s.timeline?.id === id) s.timeline.duracionMs = ms;
  });
}

function _ponerCancionActiva(s, { id, url, nombre, loop }, crossfadeMs, section = null) {
  // Durante una transición la "activa" sigue siendo la vieja; la nueva entra como "menu:transicion".
  if (s.fuentes.has("menu:transicion")) {
    _quitarFuenteDeSesion(s, "menu:transicion");
    if (s.crossfadeTimer) { clearInterval(s.crossfadeTimer); s.crossfadeTimer = null; }
  }

  const activa = s.fuentes.get("menu:activa");

  // El menú reproduce una canción a la vez (id estable "menu:activa").
  // Sin canción previa o sin crossfade: reemplazo directo.
  if (!activa || crossfadeMs <= 0) {
    const creada = agregarFuente(s.guildId, {
      id: "menu:activa",
      url,
      volumen: 1,
      loop,
      nombre,
      tipo: "menu",
      cancionId: id,
      onFin: () => {
        if (!loop) {
          if (!s.menuPlaylist) { s.timeline = null; onCambioSonando?.(null); }
          _avanzarPlaylistPorFin(s.guildId);
          // La canción acabó y no hay playlist: el control del menú queda libre.
          if (!s.menuPlaylist) { s.controlUserId = null; s.controlNombre = null; }
        }
      },
      onError: (e) => {
        console.error(`🎵 Canción del menú falló:`, e.message);
        // Si hay playlist, avanzar a la siguiente canción tras un error (ej. vídeo borrado)
        if (s.menuPlaylist) {
          setTimeout(() => _avanzarPlaylistPorFin(s.guildId), 1000).unref?.();
        }
      },
    });
    if (creada) _marcarTimeline(s, { id, url, nombre });
    return creada;
  }

  // Crossfade: la nueva entra con volumen 0 mientras la vieja se desvanece.
  const creada = agregarFuente(s.guildId, {
    id: "menu:transicion",
    url,
    volumen: 0,
    loop,
    nombre,
    tipo: "menu",
    cancionId: id,
    onFin: () => {
      if (!loop) {
        if (!s.menuPlaylist) { s.timeline = null; onCambioSonando?.(null); }
        _avanzarPlaylistPorFin(s.guildId);
        if (!s.menuPlaylist) { s.controlUserId = null; s.controlNombre = null; }
      }
    },
    onError: (e) => {
      console.error(`🎵 Canción del menú falló:`, e.message);
      // Si hay playlist, avanzar a la siguiente canción tras un error (ej. vídeo borrado)
      if (s.menuPlaylist) {
        setTimeout(() => _avanzarPlaylistPorFin(s.guildId), 1000).unref?.();
      }
    },
  });
  if (!creada) return null;
  _marcarTimeline(s, { id, url, nombre });

  let paso = 0;
  s.crossfadeTimer = setInterval(() => {
    if (!s.fuentes.has("menu:transicion")) {
      // La nueva falló: la vieja recupera su volumen y se cancela el desvanecido.
      clearInterval(s.crossfadeTimer);
      s.crossfadeTimer = null;
      if (activa) {
        s.mixer.setVolumen("menu:activa", 1);
        // El timeline vuelve a la canción que sigue sonando de verdad.
        if (s.timeline) {
          s.timeline = { id: activa.cancionId, url: activa.url, nombre: activa.nombre, inicioEn: Date.now(), duracionMs: null };
        }
      }
      return;
    }
    paso++;
    const progreso = Math.min(1, paso / PASOS_CROSSFADE);
    s.mixer.setVolumen("menu:transicion", progreso);
    if (activa) s.mixer.setVolumen("menu:activa", 1 - progreso);
    if (paso >= PASOS_CROSSFADE) {
      clearInterval(s.crossfadeTimer);
      s.crossfadeTimer = null;
      if (activa) _quitarFuenteDeSesion(s, "menu:activa");
      // La nueva pasa a ser la activa del menú: renombrar en fuentes, mixer e idRef.
      const fuente = s.fuentes.get("menu:transicion");
      if (fuente) {
        s.fuentes.delete("menu:transicion");
        s.fuentes.set("menu:activa", { ...fuente, id: "menu:activa", volumen: 1 });
        s.mixer.renombrarFuente("menu:transicion", "menu:activa");
        // Actualizar la referencia mutable para que onDatos/onFin/onError usen el nuevo id.
        if (fuente._idRef) fuente._idRef.value = "menu:activa";
      }
    }
  }, Math.max(25, crossfadeMs / PASOS_CROSSFADE));
  s.crossfadeTimer.unref?.();

  return { promesa: creada.promesa };
}

/**
 * Reproduce la categoría como una lista de reproducción (bucle al terminar):
 * cuando una canción de la categoría acaba, suena la siguiente en orden (por id).
 */
export function reproducirPlaylistCategoria(guildId, { categoria = "", canciones = [], inicioId = null, usuarioId = null, usuarioNombre = "" }) {
  const s = sesiones.get(guildId);
  if (!s || canciones.length === 0) return null;
  const bloqueo = _revisarControl(s, usuarioId);
  if (bloqueo) return { error: bloqueo };
  if (s.fuentes.has("menu:transicion")) {
    _quitarFuenteDeSesion(s, "menu:transicion");
    if (s.crossfadeTimer) { clearInterval(s.crossfadeTimer); s.crossfadeTimer = null; }
  }
  quitarFuentesManuales(guildId);
  let idx = 0;
  if (inicioId != null) {
    const hallado = canciones.findIndex((c) => c.id === inicioId);
    idx = hallado >= 0 ? hallado : 0;
  }
  s.menuPlaylist = { categoria, canciones, indice: idx };
  if (usuarioId) { s.controlUserId = usuarioId; s.controlNombre = usuarioNombre || null; }
  const section = categoria || "sin-categoria";
  const primera = canciones[idx];
  return _ponerCancionActiva(s, { id: primera.id, url: primera.url, nombre: primera.nombre, loop: false }, 0, section);
}

/** Al acabar una canción del menú, pasa a la siguiente de la playlist (y da la vuelta = loop). */
function _avanzarPlaylistPorFin(guildId) {
  const s = sesiones.get(guildId);
  if (!s?.menuPlaylist) return;
  const pl = s.menuPlaylist;
  const siguiente = (pl.indice + 1) % pl.canciones.length;
  pl.indice = siguiente;
  const c = pl.canciones[siguiente];
  const section = pl.categoria || "sin-categoria";
  _ponerCancionActiva(s, { id: c.id, url: c.url, nombre: c.nombre, loop: false }, 0, section);
}

/** Detiene la canción del menú si estaba sonando. */
export function pararCancionMenu(guildId) {
  const s = sesiones.get(guildId);
  if (!s) return false;
  if (s.crossfadeTimer) { clearInterval(s.crossfadeTimer); s.crossfadeTimer = null; }
  s.menuPlaylist = null;
  s.timeline = null;
  s.controlUserId = null;
  s.controlNombre = null;
  s.currentSection = null;
  onCambioSonando?.(null);
  let quitada = false;
  for (const id of ["menu:activa", "menu:transicion"]) {
    if (s.fuentes.has(id)) {
      _quitarFuenteDeSesion(s, id);
      quitada = true;
    }
  }
  return quitada;
}

/** Estado de la canción del menú en la sesión (para el panel). */
export function estadoCancionMenu(guildId) {
  const s = sesiones.get(guildId);
  const fuente = s?.fuentes.get("menu:transicion") ?? s?.fuentes.get("menu:activa");
  const volumen = s ? Math.round((s.mixer.getVolumenGlobal?.() ?? 1) * 100) : 100;
  if (!fuente) return { sonando: false, url: null, nombre: null, cancionId: null, inicioEn: null, duracionMs: null, volumen };
  return {
    sonando: true,
    url: fuente.url,
    nombre: fuente.nombre,
    cancionId: fuente.cancionId ?? null,
    inicioEn: s?.timeline?.inicioEn ?? null,
    duracionMs: s?.timeline?.duracionMs ?? null,
    volumen,
  };
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
