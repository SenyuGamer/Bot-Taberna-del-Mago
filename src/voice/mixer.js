import { Readable } from "node:stream";

// Mixer PCM: mezcla N fuentes de audio en una única salida s16le 48 kHz estéreo.
//
// Formato: frame de 20 ms = 960 muestras × 2 canales × 2 bytes = 3840 bytes.
// El reloj interno está ANCLADO al reloj de pared: cada ciclo emite los frames que
// corresponden al tiempo transcurrido (rellenando con silencio si una fuente no
// llega a tiempo). Así el stream ogg/opus sale CONTINUO a 50 fps reales y Discord
// nunca se queda sin frames (evita el audio "cortado / mala conexión" progresivo).
// Si el event-loop se cuelga, re-anclamos el reloj a "ahora" (sin latencia acumulada).

export const FRAME_BYTES = 960 * 2 * 2;
const MAX_FRAMES_EN_COLA = 50; // ~1 segundo de cola por fuente (tope "suave": la tubería debe pausarse aquí)
const MIN_FRAMES_EN_COLA = 25; // al bajar de aquí, se reanuda la tubería (histéresis)
const CAP_HARD_FRAMES = 120; // tope duro de memoria; con backpressure no debería alcanzarse
const SILENCIO = Buffer.alloc(FRAME_BYTES);
const MS_FRAME = 20; // duración de un frame
const TICK_MS = 10; // granularidad del reloj (tick fino → emite 0, 1 o 2 frames)
const BURST_MAX = 25; // ráfaga máxima tras un atraso del event-loop (~500 ms); si vamos MÁS atrás, re-anclamos
const LEAD_FRAMES = 5; // colchón de arranque: ~100 ms antes de consumir una fuente

export function clampVolumen(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export class Mixer {
  constructor({ intervaloMs = 20 } = {}) {
    this.fuentes = new Map(); // id -> { frames: Buffer[], resto: Buffer|null, volumen, recibido }
    this.pausado = false;
    this.master = 1; // volumen global de la sesión (0..1)
    this.salida = new Readable({ read() {} });
    this._t0 = Date.now(); // origen del reloj de pared
    this._emitidos = 0; // frames emitidos desde _t0
    this.underruns = 0; // contador de frames donde una fuente activa no tenía audio
    this._tickFn = () => this.tick();
    const paso = Math.min(TICK_MS, Number.isFinite(intervaloMs) && intervaloMs > 0 ? intervaloMs : TICK_MS);
    this.temporizador = setInterval(this._tickFn, paso);
    this.temporizador.unref?.();
  }

  agregarFuente(id, volumen = 1) {
    this.fuentes.set(id, { frames: [], resto: null, volumen: clampVolumen(volumen), recibido: false, arrancado: false, onStockBajo: null });
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

  /** Volumen global de la salida mezclada (0..1). */
  setVolumenGlobal(volumen) {
    this.master = clampVolumen(volumen);
  }

  getVolumenGlobal() {
    return this.master;
  }

  setPausado(pausado) {
    this.pausado = !!pausado;
  }

  /**
   * Recibe bytes arbitrarios de la tubería y los trocea en frames de 20 ms.
   * Devuelve `true` si la tubería puede seguir descargando y `false` si la cola
   * está llena (el pipeline debe PAUSAR su ffmpeg hasta que se consuma).
   */
  empujar(id, bytes) {
    const fuente = this.fuentes.get(id);
    if (!fuente || !bytes?.length) return true;
    fuente.recibido = true;
    fuente.resto = fuente.resto ? Buffer.concat([fuente.resto, bytes]) : bytes;
    while (fuente.resto.length >= FRAME_BYTES) {
      fuente.frames.push(fuente.resto.subarray(0, FRAME_BYTES));
      fuente.resto = fuente.resto.subarray(FRAME_BYTES);
    }
    // Tope duro de memoria: SOLO en caso patológico (con backpressure no se alcanza).
    if (fuente.frames.length > CAP_HARD_FRAMES) {
      fuente.frames.splice(0, fuente.frames.length - CAP_HARD_FRAMES);
    }
    return fuente.frames.length < MAX_FRAMES_EN_COLA;
  }

  /** Cuando la cola de una fuente baja de MIN, avisa para reanudar la tubería. */
  setStockBajo(id, fn) {
    const fuente = this.fuentes.get(id);
    if (fuente) fuente.onStockBajo = fn;
  }

  /**
   * Ciclo del reloj: emite los frames que corresponden al tiempo real transcurrido.
   * Si vamos MUY atrás (> BURST_MAX), re-anclamos el reloj en vez de emitir una
   * ráfaga de audio viejo: el ogg/opus debe ir a 50 fps exactos, siempre.
   */
  tick() {
    const ahora = Date.now();
    const objetivos = Math.floor((ahora - this._t0) / MS_FRAME);
    let aEmitir = objetivos - this._emitidos;
    if (aEmitir > BURST_MAX) {
      this._t0 = ahora;
      this._emitidos = objetivos;
      aEmitir = 1;
    }
    if (aEmitir <= 0) return null;
    this._emitidos += aEmitir;
    let ultimo = null;
    for (let i = 0; i < aEmitir; i++) ultimo = this._emitirUnFrame();
    return ultimo;
  }

  /** Genera y emite un frame mezclado de 20 ms (o silencio si no hay nada). */
  _emitirUnFrame() {
    const frame = this.pausado || this.fuentes.size === 0 ? SILENCIO : this._mezclar();
    this._emitir(frame);
    return frame;
  }

  _mezclar() {
    const frame = Buffer.alloc(FRAME_BYTES);
    for (const fuente of this.fuentes.values()) {
      if (!fuente.arrancado) {
        // Colchón de arranque: no consumimos hasta tener ~100 ms, para que la
        // tubería gane tiempo de sobra y el primer tramo no tenga silencios.
        if (fuente.recibido && fuente.frames.length >= LEAD_FRAMES) fuente.arrancado = true;
        continue;
      }
      const frameFuente = fuente.frames.shift();
      if (!frameFuente) {
        // Fuente arrancada pero sin audio disponible: subalimentación. Con el
        // ritmo anclado y sin -re en la tubería esto no debería ocurrir en marcha.
        if (fuente.recibido) this.underruns++;
        continue; // esa fuente no tiene audio aún: silencio parcial
      }
      if (fuente.frames.length < MIN_FRAMES_EN_COLA) fuente.onStockBajo?.();
      const volumen = fuente.volumen;
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        const muestra = Math.round(frameFuente.readInt16LE(i) * volumen);
        const mezcla = frame.readInt16LE(i) + muestra;
        const valor = mezcla > 32767 ? 32767 : mezcla < -32768 ? -32768 : mezcla;
        frame.writeInt16LE(valor, i);
      }
    }
    if (this.master !== 1) {
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        const v = Math.round(frame.readInt16LE(i) * this.master);
        frame.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
      }
    }
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
