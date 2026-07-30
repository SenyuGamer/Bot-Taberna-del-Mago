import { spawn } from "node:child_process";

// Pipeline por link: yt-dlp (descarga el audio de la URL) → ffmpeg (lo convierte a
// PCM s16le 48 kHz estéreo) → bytes al mixer. Rutas configurables por .env para la
// Orange Pi (RISC-V usa los binarios del sistema instalados con apt).

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

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
 */
export function crearPipeline({ url, loop = false, loopDelayMs, onDatos, onFin, onError, rutas = {} }) {
  const cmdYt = rutas.yt ?? YTDLP;
  const cmdFf = rutas.ff ?? FFMPEG;
  let ytActual = null;
  let ffActual = null;
  let detenido = false;
  let primerChunk = true;

  const lanzar = () => {
    if (detenido) return;

    let yt;
    let ff;
    try {
      yt = spawn(cmdYt, ["--no-playlist", "--no-progress", "-f", "bestaudio/best", "-o", "-", url], { stdio: ["ignore", "pipe", "pipe"] });
      ff = spawn(cmdFf, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      onError?.(new Error(`No se pudo lanzar la tubería de audio: ${error.message}`));
      return;
    }
    ytActual = yt;
    ffActual = ff;

    yt.stdout.pipe(ff.stdin);

    ff.stdout.on("data", (bytes) => {
      if (detenido) return;
      if (primerChunk) {
        primerChunk = false;
        eventos.primerChunk?.();
      }
      onDatos?.(bytes);
    });

    let erroresYt = "";
    yt.stderr.on("data", (d) => { erroresYt += d.toString(); });
    ff.stderr.on("data", () => {}); // ffmpeg -loglevel error: solo ruido informativo

    yt.on("error", (error) => {
      if (detenido) return;
      onError?.(new Error(`yt-dlp no disponible o falló al iniciar: ${error.message}. ¿Está instalado en la Pi? (apt install yt-dlp)`));
    });

    yt.on("close", (code) => {
      try { ff.stdin.end(); } catch {}
      if (!detenido && code && code !== 0) {
        onError?.(new Error(`yt-dlp falló (código ${code}): ${erroresYt.trim().slice(-250) || "URL no soportada"}`));
      }
    });

    ff.on("error", (error) => {
      if (detenido) return;
      onError?.(new Error(`ffmpeg no disponible o falló al iniciar: ${error.message}. ¿Está instalado en la Pi? (apt install ffmpeg)`));
    });

    ff.on("close", (code) => {
      ytActual = null;
      ffActual = null;
      if (detenido) return;
      if (loop) {
        const espera = typeof loopDelayMs === "function" ? loopDelayMs() : (loopDelayMs ?? 750);
        setTimeout(() => { if (!detenido) lanzar(); }, espera).unref?.();
      } else {
        onFin?.(code);
      }
    });
  };

  const eventos = {};
  lanzar();

  return {
    detener() {
      detenido = true;
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
    esperarPrimerAudio(timeoutMs = 12_000) {
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
