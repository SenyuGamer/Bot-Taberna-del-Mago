import { spawn } from "node:child_process";

// RISC-V: opusscript (build WASM de 2019) crashea en Node 22. Para encodear el
// PCM mezclado a opus usamos ffmpeg del sistema (libopus) y emitimos ogg/opus,
// que @discordjs/voice solo demuxa (sin tocar opusscript).
// Rutas configurables por .env para pruebas en la Orange Pi.

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export function crearEncoderOpus({ onError }) {
  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
    "-c:a", "libopus", "-page_duration", "20",
    "-f", "ogg", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  ff.stdin.on("error", () => {}); // EPIPE esperable al cerrar el flujo
  ff.stdout.on("error", () => {});
  ff.stderr.on("data", (d) => {
    const linea = d.toString().trim();
    if (linea) onError?.(new Error(`ffmpeg-opus: ${linea}`));
  });
  ff.on("error", (error) => {
    onError?.(new Error(`No se pudo lanzar el encoder opus: ${error.message}. ¿Está ffmpeg instalado? (apt install ffmpeg)`));
  });

  return ff;
}