import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

// Pipeline por link: yt-dlp (descarga el audio de la URL) → ffmpeg (lo convierte a
// PCM s16le 48 kHz estéreo) → bytes al mixer. Rutas configurables por .env para la
// Orange Pi (RISC-V usa los binarios del sistema instalados con apt).
//
// Caché: el archivo descargado se guarda en disco (data/music-cache). La siguiente
// vez que se reproduce la MISMA URL se lee del disco con ffmpeg (sin yt-dlp ni red),
// por eso la segunda reproducción arranca mucho más rápido.

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const CACHE_DIR = process.env.MUSIC_CACHE_DIR || "data/music-cache";

/**
 * Crea la tubería de audio para una URL.
 * @param {object} opts
 * @param {string} opts.url
 * @param {boolean} [opts.loop] reinicia la tubería al terminar
 * @param {number | (() => number)} [opts.loopDelayMs] espera entre repeticiones (número o fábrica para aleatorio)
 * @param {(bytes: Buffer) => void} opts.onDatos
 * @param {(code: number|null) => void} [opts.onFin]  fin cuando NO es loop
 * @param {(error: Error) => void} [opts.onError]
 * @param {{yt?: string, ff?: string}} [opts.rutas] para pruebas
 * @param {string|null} [opts.cacheDir] directorio de caché del audio (null = sin caché)
 */
export function crearPipeline({ url, loop = false, loopDelayMs, onDatos, onFin, onError, rutas = {}, cacheDir = CACHE_DIR }) {
  const cmdYt = rutas.yt ?? YTDLP;
  const cmdFf = rutas.ff ?? FFMPEG;
  const MAX_REINTENTOS = 4;
  const MAX_REINTENTOS_MEDIO = 3; // relanzar si YouTube corta la descarga a mitad
  let ytActual = null;
  let ffActual = null;
  let detenido = false;
  let primerChunk = false;
  let reintentos = 0;
  let reintentosMedio = 0;
  let reintentando = false;
  const eventos = {};

  // Archivo de caché = sha256(url). Lo buscamos SOLO para enlaces HTTP
  // (las URLs del menú nunca son ficheros locales).
  let archivoCache = null;
  let escritorCache = null;
  const esHttp = /^https?:\/\//i.test(url);
  if (cacheDir && esHttp) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      archivoCache = join(cacheDir, `${createHash("sha256").update(url).digest("hex")}.weba`);
    } catch { archivoCache = null; }
  }

  const finalizarError = (e) => { if (!detenido) onError?.(e); };

  const lanzar = () => {
    if (detenido) return;

    const usarCache = archivoCache && existsSync(archivoCache);
    if (usarCache) console.log(`🎵 Caché: leyendo <${url}> desde disco.`);

    let yt;
    let ff;
    try {
      if (usarCache) {
        // Sin yt-dlp: ffmpeg decodifica directo el archivo guardado en disco.
        ff = spawn(cmdFf, ["-hide_banner", "-loglevel", "error", "-re", "-i", archivoCache, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
      } else {
        yt = spawn(cmdYt, [
          "--no-playlist", "--no-progress",
          // YouTube exige runtime JS para resolver retos ("n challenge"); usamos el node del bot.
          "--js-runtimes", `node:${process.execPath}`,
          // Probar varios clientes hasta dar con uno que no responda 403.
          "--extractor-args", "youtube:player_client=android,ios,web,tv",
          "--retries", "3", "--fragment-retries", "3",
          "-f", "bestaudio/best", "-o", "-", url,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        ff = spawn(cmdFf, ["-hide_banner", "-loglevel", "error", "-re", "-i", "pipe:0", "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
        if (archivoCache) {
          // Guarda una copia de lo que descarga yt-dlp para la próxima vez.
          try {
            escritorCache = createWriteStream(`${archivoCache}.part`);
            yt.stdout.pipe(escritorCache);
            escritorCache.on("error", () => {});
          } catch { escritorCache = null; }
        }
      }
    } catch (error) {
      finalizarError(new Error(`No se pudo lanzar la tubería de audio: ${error.message}`));
      return;
    }
    reintentando = false;
    ytActual = yt;
    ffActual = ff;

    yt?.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {}); // EPIPE esperable al cerrar la tubería
    yt?.stdout.on("error", () => {});
    ff.stdout.on("error", () => {});

    ff.stdout.on("data", (bytes) => {
      if (detenido) return;
      if (!primerChunk) {
        primerChunk = true;
        eventos.primerChunk?.();
      }
      onDatos?.(bytes);
    });

    let erroresYt = "";
    yt?.stderr.on("data", (d) => { erroresYt += d.toString(); });
    ff.stderr.on("data", () => {}); // ffmpeg -loglevel error: solo ruido informativo

    yt?.on("error", (error) => {
      if (detenido) return;
      finalizarError(new Error(`yt-dlp no disponible o falló al iniciar: ${error.message}. ¿Está instalado en la Pi? (apt install yt-dlp)`));
    });

    yt?.on("close", (code) => {
      // Descarga terminada: si terminó bien, convertimos la copia parcial en caché definitiva.
      if (escritorCache) {
        escritorCache.end();
        escritorCache = null;
        if (code === 0 && archivoCache && !detenido) {
          try { renameSync(`${archivoCache}.part`, archivoCache); console.log(`🎵 Caché: guardada <${url}> en disco.`); } catch {}
        }
      }
      try { ff.stdin.end(); } catch {}
      if (detenido) return;
      if (code && code !== 0 && !primerChunk && reintentos < MAX_REINTENTOS) {
        // YouTube rate-limita las IP (HTTP 403) de forma intermitente: reintentamos.
        reintentos++;
        reintentando = true;
        setTimeout(lanzar, 1500 * reintentos).unref?.();
      } else if (code && code !== 0 && primerChunk && reintentosMedio < MAX_REINTENTOS_MEDIO) {
        // YouTube cortó la descarga a mitad de la canción: relanzamos desde el inicio
        // (mejor que quedarse en silencio).
        reintentosMedio++;
        reintentando = true;
        console.log(`🎵 Descarga cortada por YouTube (código ${code}); relanzando (${reintentosMedio}/${MAX_REINTENTOS_MEDIO}).`);
        setTimeout(lanzar, 2000).unref?.();
      } else if (code && code !== 0) {
        finalizarError(new Error(`yt-dlp falló (código ${code}): ${erroresYt.trim().slice(-250) || "URL no soportada"}`));
      }
    });

    ff.on("error", (error) => {
      if (detenido) return;
      finalizarError(new Error(`ffmpeg no disponible o falló al iniciar: ${error.message}. ¿Está instalado en la Pi? (apt install ffmpeg)`));
    });

    ff.on("close", (code) => {
      ytActual = null;
      ffActual = null;
      if (detenido) return;
      if (loop) {
        const espera = typeof loopDelayMs === "function" ? loopDelayMs() : (loopDelayMs ?? 750);
        setTimeout(() => { if (!detenido) lanzar(); }, espera).unref?.();
      } else if (reintentando) {
        // Hay un reintento en curso (pre- o mid-stream); esperamos su desenlace.
      } else if (!primerChunk) {
        finalizarError(new Error("La tubería de audio terminó sin emitir audio."));
      } else {
        onFin?.(code);
      }
    });
  };

  lanzar();

  return {
    detener() {
      detenido = true;
      if (escritorCache) { try { escritorCache.destroy(); } catch {} escritorCache = null; }
      if (archivoCache) {
        try { rmSync(`${archivoCache}.part`, { force: true }); } catch {}
      }
      for (const proc of [ytActual, ffActual]) {
        try { proc?.kill("SIGTERM"); } catch {}
      }
      const retraso = setTimeout(() => {
        for (const proc of [ytActual, ffActual]) {
          try { proc?.kill("SIGKILL"); } catch {}
        }
      }, 2000);
      retraso.unref?.();
    },
    /** Resuelve con el primer chunk PCM (la URL suena) o rechaza al primer error. */
    esperarPrimerAudio(timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Tiempo agotado esperando audio (¿URL válida de YouTube?)")), timeoutMs);
        t.unref?.();
        const onErrorAntiguo = onError;
        onError = (e) => { clearTimeout(t); reject(e); onErrorAntiguo?.(e); };
        eventos.primerChunk = () => { clearTimeout(t); resolve(); };
      });
    },
    estaVivo: () => !detenido,
  };
}

/**
 * Descarga SOLO a la caché (sin reproducir) para que la reproducción posterior
 * arranque rápido. Devuelve una promesa con { yaExistia }. Idempotente por URL.
 * @param {{url: string, cacheDir?: string, rutas?: {yt?: string}}} opts
 */
export function precargarCache({ url, cacheDir = CACHE_DIR, rutas = {} }) {
  const cmdYt = rutas.yt ?? YTDLP;
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Solo se puede precargar una URL HTTP."));

  const archivo = join(cacheDir, `${createHash("sha256").update(url).digest("hex")}.weba`);
  if (existsSync(archivo)) return Promise.resolve({ yaExistia: true });

  return new Promise((resolve, reject) => {
    try { mkdirSync(cacheDir, { recursive: true }); } catch {}
    let yt;
    try {
      yt = spawn(cmdYt, [
        "--no-playlist", "--no-progress",
        "--js-runtimes", `node:${process.execPath}`,
        "--extractor-args", "youtube:player_client=android,ios,web,tv",
        "--retries", "3", "--fragment-retries", "3",
        "-f", "bestaudio/best", "-o", "-", url,
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return reject(new Error(`No se pudo lanzar yt-dlp: ${error.message}`));
    }

    const escritor = createWriteStream(`${archivo}.part`);
    yt.stdout.pipe(escritor);
    let errores = "";
    yt.stderr.on("data", (d) => { if (errores.length < 2000) errores += d.toString(); });
    yt.on("error", (error) => {
      try { escritor.destroy(); } catch {}
      try { rmSync(`${archivo}.part`, { force: true }); } catch {}
      reject(new Error(`yt-dlp no disponible: ${error.message}`));
    });
    yt.on("close", (code) => {
      escritor.end(() => {
        if (code === 0) {
          try {
            renameSync(`${archivo}.part`, archivo);
            console.log(`🎵 Pré-caché: <${url}> guardada en disco.`);
            resolve({ yaExistia: false });
          } catch (error) {
            try { rmSync(`${archivo}.part`, { force: true }); } catch {}
            reject(error);
          }
        } else {
          try { rmSync(`${archivo}.part`, { force: true }); } catch {}
          reject(new Error(`yt-dlp falló (código ${code}): ${errores.trim().slice(-250) || "URL no soportada"}`));
        }
      });
    });
  });
}