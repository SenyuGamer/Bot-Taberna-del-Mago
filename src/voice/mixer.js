import { Readable } from "node:stream";

// Mixer PCM: mezcla N fuentes de audio en una única salida s16le 48 kHz estéreo.
//
// Formato: frame de 20 ms = 960 muestras × 2 canales × 2 bytes = 3840 bytes.
// El reloj interno emite un frame cada 20 ms; @discordjs/voice consume a su ritmo,
// así que si la salida va lenta descartamos frames (memoria acotada, sin latencia
// creciente).

export const FRAME_BYTES = 960 * 2 * 2;
const MAX_FRAMES_EN_COLA = 50; // ~1 segundo de cola por fuente
const SILENCIO = Buffer.alloc(FRAME_BYTES);

export function clampVolumen(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export class Mixer {
  constructor({ intervaloMs = 20 } = {}) {
    this.fuentes = new Map(); // id -> { frames: Buffer[], resto: Buffer|null, volumen }
    this.pausado = false;
    this.salida = new Readable({ read() {} });
    this._tickFn = () => this.tick();
    this.temporizador = setInterval(this._tickFn, intervaloMs);
    this.temporizador.unref?.();
  }

  agregarFuente(id, volumen = 1) {
    this.fuentes.set(id, { frames: [], resto: null, volumen: clampVolumen(volumen) });
  }

  quitarFuente(id) {
    this.fuentes.delete(id);
  }

  setVolumen(id, volumen) {
    const fuente = this.fuentes.get(id);
    if (fuente) fuente.volumen = clampVolumen(volumen);
  }

  getVolumen(id) {
    return this.fuentes.get(id)?.volumen ?? null;
  }

  setPausado(pausado) {
    this.pausado = !!pausado;
  }

  /** Recibe bytes arbitrarios de la tubería y los trocea en frames de 20 ms. */
  empujar(id, bytes) {
    const fuente = this.fuentes.get(id);
    if (!fuente || !bytes?.length) return;
    fuente.resto = fuente.resto ? Buffer.concat([fuente.resto, bytes]) : bytes;
    while (fuente.resto.length >= FRAME_BYTES) {
      fuente.frames.push(fuente.resto.subarray(0, FRAME_BYTES));
      fuente.resto = fuente.resto.subarray(FRAME_BYTES);
    }
    // Si la fuente produce más rápido de lo que consumimos, descartamos lo más viejo
    while (fuente.frames.length > MAX_FRAMES_EN_COLA) fuente.frames.shift();
  }

  /** Genera y emite el frame mezclado de este ciclo de 20 ms. */
  tick() {
    if (this.pausado || this.fuentes.size === 0) {
      return this._emitir(SILENCIO);
    }
    const frame = Buffer.alloc(FRAME_BYTES);
    for (const fuente of this.fuentes.values()) {
      const frameFuente = fuente.frames.shift();
      if (!frameFuente) continue; // esa fuente no tiene audio aún: silencio parcial
      const volumen = fuente.volumen;
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        const muestra = Math.round(frameFuente.readInt16LE(i) * volumen);
        const mezcla = frame.readInt16LE(i) + muestra;
        const valor = mezcla > 32767 ? 32767 : mezcla < -32768 ? -32768 : mezcla;
        frame.writeInt16LE(valor, i);
      }
    }
    this._emitir(frame);
    return frame;
  }

  _emitir(frame) {
    // Si push() devuelve false, el consumidor va lento; igualmente seguimos
    // (los buffers internos de Readable se vacían solos y acotamos por fuente).
    this.salida.push(frame);
    return frame;
  }

  detener() {
    clearInterval(this.temporizador);
    this.salida.push(null);
    this.fuentes.clear();
  }
}

/** Genera un frame PCM s16le estéreo de una onda constante (para pruebas). */
export function frameDePrueba(valor = 1000) {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) frame.writeInt16LE(valor, i);
  return frame;
}
