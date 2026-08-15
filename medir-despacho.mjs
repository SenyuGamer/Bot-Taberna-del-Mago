import { createAudioPlayer, createAudioResource, StreamType } from "@discordjs/voice";

const { Mixer, frameDePrueba } = await import("./src/voice/mixer.js");
const crearEncoderOpus = (await import("./src/voice/encoderOpus.js")).crearEncoderOpus;

// Conexión falsa: solo cuenta los paquetes despachados y cuándo.
const conexion = {
  estado: "ready",
  preparados: 0,
  despachados: 0,
  reporte: [],
  prepareAudioPacket() { this.preparados++; },
  dispatchAudio() {
    this.despachados++;
    this.reporte.push(Date.now());
  },
  setSpeaking() {},
};
const player = createAudioPlayer({ behaviors: { noSubscriber: "pause" } });

// La conexión falsa debe parecer "ready" para el player.
conexion.state = { status: "ready" };
player.subscribe(conexion);

const mixer = new Mixer();
mixer.agregarFuente("test", 1);
mixer.empujar("test", Buffer.concat(Array.from({ length: 25 }, () => frameDePrueba(1500)))); // 0.5s de tono real

const ffEnc = crearEncoderOpus({ onError: (e) => console.error("[ff]", e.message) });
mixer.salida.pipe(ffEnc.stdin);
ffEnc.stdout.on("data", (d) => {
  if (!(ffEnc.stdout.bytes ?? 0)) ffEnc.stdout.t0 = Date.now();
  ffEnc.stdout.bytes = (ffEnc.stdout.bytes ?? 0) + d.length;
});
const recurso = createAudioResource(ffEnc.stdout, { inputType: StreamType.OggOpus });
const originalRead = recurso.read?.bind(recurso);
const resourceLeo = { n: 0 };
recurso.read = () => { const p = originalRead ? originalRead() : recurso.playStream?.read(); resourceLeo.n++; return p; };
setInterval(() => {
  console.log(`[stat] bytesOgg=${ffEnc.stdout.bytes ?? 0}  resourceLeo=${resourceLeo.n}  playStream.readable=${recurso.playStream?.readable}`);
}, 2000);
player.play(recurso);

console.log("player tras play:", player.state.status);

let t0 = Date.now();
const muestreo = setInterval(() => {
  const real = (Date.now() - t0) / 1000;
  console.log(
    `real=${real.toFixed(1)}s  despachados=${conexion.despachados}  preparados=${conexion.preparados}  tasa=${(conexion.despachados / Math.max(0.01, real)).toFixed(0)}/s`
  );
  if (real >= 5.5) {
    clearInterval(muestreo);
    process.exit(0);
  }
}, 1000);