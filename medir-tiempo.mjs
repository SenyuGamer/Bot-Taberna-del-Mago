import { spawn } from "node:child_process";
import { Mixer } from "./src/voice/mixer.js";

// Diagnóstico: ¿el encoder ffmpeg produce audio más rápido que el tiempo real?
// El mixer empuja 1 frame (20ms) cada 20ms → debe salir ~1s de audio por 1s real.
const ffEnc = spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "error",
  "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
  "-c:a", "libopus", "-page_duration", "20",
  "-f", "ogg", "pipe:1",
], { stdio: ["pipe", "pipe", "pipe"] });
ffEnc.stderr.on("data", (d) => process.stderr.write("[ff] " + d));

const mixer = new Mixer();
mixer.agregarFuente("test", 1);
mixer.salida.pipe(ffEnc.stdin);

const OGG_PAGE_H = Buffer.from([...'OggS'].map((c) => c.charCodeAt(0)));
let resto = null;
let ultimoGranule = 0n;
let primera = true;

ffEnc.stdout.on("data", (chunk) => {
  if (resto) chunk = Buffer.concat([resto, chunk]);
  while (chunk.length >= 27) {
    if (!chunk.slice(0, 4).equals(OGG_PAGE_H)) { resto = chunk; return; }
    const seg = chunk.readUInt8(26);
    const table = chunk.slice(27, 27 + seg);
    let total = 0;
    for (let i = 0; i < seg;) {
      let s = 0, x = 255;
      while (x === 255) { x = table.readUInt8(i); i++; s += x; }
      total += s;
    }
    const pageLen = 27 + seg + total;
    if (chunk.length < pageLen) { resto = chunk; return; }
    const granule = chunk.readBigUInt64LE(6);
    if (primera) { primera = false; ultimoGranule = granule; }
    else ultimoGranule = granule;
    chunk = chunk.slice(pageLen);
  }
  resto = chunk;
});

let t0 = Date.now();
const total = setInterval(() => {
  const real = (Date.now() - t0) / 1000;
  const audio = Number(ultimoGranule) / 48000;
  console.log(
    `real=${real.toFixed(1)}s  audio_generado=${audio.toFixed(1)}s  ratio=${(audio / Math.max(0.01, real)).toFixed(2)}x`
  );
  if (real >= 5.5) { clearInterval(total); process.exit(0); }
}, 1000);