import express from "express";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  agregarCancionMenu,
  borrarCancionMenu,
  getCancionMenu,
  getGuildPorToken,
  listarCancionesMenu,
  setGuildPorToken,
} from "./db.js";
import {
  reproducirCancionMenu,
  pararCancionMenu,
  estadoCancionMenu,
  getSesion,
  unir,
  canalGuardado,
} from "./voice/sessionManager.js";

// Puente HTTP DJGambit â†’ Discord.
// - El panel (navegador del DM dentro de Owlbear) se vincula con un cÃ³digo de
//   verificaciÃ³n y luego maneja el menÃº global de canciones: aÃ±adir, quitar y
//   reproducir â€” el audio suena SOLO en el bot, nunca en el navegador.
// - Se sirve el build estÃ¡tico del panel con CORS porque Owlbear Rodeo carga
//   la extensiÃ³n desde otro origen (owlbear.rodeo).
// Sin puertos abiertos: sale por el tÃºnel de Cloudflare.

const DJGAMBIT_PORT = Number(process.env.DJGAMBIT_PORT || 0);
const DJGAMBIT_DIR = process.env.DJGAMBIT_DIR || "src/djgambit/build";

const TTL_CODIGO_MS = 10 * 60 * 1000; // el cÃ³digo de verificaciÃ³n dura 10 min
const codigos = new Map(); // codigo -> { guildId, expira }
let clienteActual = null; // client de discord.js (para unir al canal al reproducir)

// ---------- Rutas temporales (callbacks OAuth de Twitch) ----------
// El mismo servidor sirve la mÃºsica y los callbacks de /sincronizar twitch,
// asÃ­ SOLO hace falta UN tÃºnel/puerto. twitch.js registra aquÃ­ su callback.

const rutasTemporales = new Map(); // path -> manejador(req, res)
let servidorActivo = null;

export function puenteListo() {
  return servidorActivo !== null;
}

/**
 * Registra una ruta temporal (GET) que resuelve una promesa con el resultado
 * del manejador. manejador(url) â†’ { status, html, valor? , rechazar? }
 */
export function registrarRutaTemporal(path, { timeoutMs = 5 * 60_000, manejador } = {}) {
  if (rutasTemporales.has(path)) {
    throw new Error(`Ya hay una espera activa para ${path}`);
  }
  const promesa = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rutasTemporales.delete(path);
      reject(new Error(`Se agotÃ³ el tiempo de espera (${Math.round(timeoutMs / 60000)} min). Vuelve a usar el comando.`));
    }, timeoutMs);
    timer.unref?.();

    rutasTemporales.set(path, async (req, res) => {
      try {
        const resultado = await manejador(new URL(req.url, "http://localhost"));
        res.writeHead(resultado.status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(resultado.html);
        clearTimeout(timer);
        rutasTemporales.delete(path);
        if (resultado.valor !== undefined) resolve(resultado.valor);
        else reject(new Error(resultado.rechazar ?? "Fallo desconocido del callback."));
      } catch (error) {
        clearTimeout(timer);
        rutasTemporales.delete(path);
        try { res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }); res.end("<p>âŒ Error interno.</p>"); } catch {}
        reject(error);
      }
    });
  });
  // Evita unhandledRejection si rechaza antes de que el consumidor haga await
  promesa.catch(() => {});
  return { promesa };
}

/**
 * Genera un cÃ³digo de verificaciÃ³n de un solo uso para vincular el panel a un
 * servidor de Discord. Lo crea el comando /djgambit vincular.
 */
export function generarCodigoVinculacion(guildId) {
  // Limpia cÃ³digos caducados de la misma guild
  for (const [codigo, info] of codigos) {
    if (info.guildId === guildId && info.expira < Date.now()) codigos.delete(codigo);
  }
  let codigo = "";
  do {
    codigo = randomInt(100000, 999999).toString();
  } while (codigos.has(codigo));
  codigos.set(codigo, { guildId, expira: Date.now() + TTL_CODIGO_MS });
  return codigo;
}

function leerToken(req) {
  const auth = req.headers.authorization ?? "";
  const m = auth.match(/^Bearer\s+([^\s]+)$/i);
  return m ? m[1] : null;
}

/** Devuelve el guildId vinculado al token del panel, o null. */
function guildDeToken(req) {
  const token = leerToken(req);
  return token ? getGuildPorToken(token) : null;
}

/**
 * Reprocha una canciÃ³n del menÃº en el guild vinculado. Si el bot no estÃ¡ en el
 * canal de voz, intenta unirse al que haya guardado (/musica unir anterior).
 */
async function reproducirConSesion(req, res, guildId, cancion) {
  let sesion = getSesion(guildId);
  let canalId = sesion?.canalId ?? canalGuardado(guildId);

  if (!sesion && canalId && clienteActual) {
    const guild = clienteActual.guilds.cache.get(guildId);
    const canal = guild?.channels.cache.get(canalId);
    if (guild && canal?.isVoiceBased?.()) {
      try {
        sesion = await unir(guild, canal, clienteActual.user.id);
      } catch (error) {
        console.error(`ðŸŽµ No pude unir el bot para el menÃº en ${guildId}:`, error.message);
      }
    }
  }

  if (!getSesion(guildId)) {
    return res.status(409).json({
      ok: false,
      error: "El bot no estÃ¡ en un canal de voz. Conecta el bot con /musica unir y vuelve a pulsar.",
    });
  }

  try {
    const creado = reproducirCancionMenu(guildId, {
      id: cancion.id,
      url: cancion.url,
      nombre: cancion.nombre,
      loop: cancion.loop,
    });
    if (!creado) return res.status(409).json({ ok: false, error: "No hay sesiÃ³n de voz activa." });
    await creado.promesa;
    res.json({ ok: true, cancion: { id: cancion.id, nombre: cancion.nombre, url: cancion.url } });
  } catch (error) {
    console.error(`ðŸŽµ Error reproduciendo ${cancion.nombre}:`, error.message);
    res.status(502).json({ ok: false, error: `No pude reproducir esa canciÃ³n: ${error.message}` });
  }
}

export function crearAppDjgambit() {
  const app = express();
  app.disable("x-powered-by");

  // CORS: Owlbear Rodeo carga la extensiÃ³n desde owlbear.rodeo (origen cruzado)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.text({ type: "text/plain", limit: "128kb" })); // para sendBeacon al cerrar la pestaÃ±a
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, nombre: "taberna-mago djgambit bridge", canciones: listarCancionesMenu().length });
  });

  // ---------- VinculaciÃ³n con cÃ³digo ----------
  // El DM genera un cÃ³digo con /djgambit vincular y lo introduce en el panel.
  app.post("/api/djgambit/vincula", (req, res) => {
    const codigo = String(req.body?.codigo ?? "").trim();
    const info = codigos.get(codigo);
    if (!info || info.expira < Date.now()) {
      if (info) codigos.delete(codigo);
      return res.status(401).json({ ok: false, error: "CÃ³digo invÃ¡lido o caducado. Genera uno nuevo con /djgambit vincular." });
    }
    codigos.delete(codigo); // un solo uso
    const token = randomBytes(24).toString("hex");
    setGuildPorToken(token, info.guildId);
    const guild = clienteActual?.guilds.cache.get(info.guildId);
    res.json({ ok: true, token, guildId: info.guildId, guildName: guild?.name ?? "" });
  });

  // ---------- MenÃº global de canciones ----------

  app.get("/api/djgambit/menu", (_req, res) => {
    res.json({ ok: true, canciones: listarCancionesMenu() });
  });

  app.post("/api/djgambit/menu", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /djgambit vincular." });
    const { nombre, icono = "", url = "", loop = false } = req.body ?? {};
    if (!nombre?.trim() || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "Nombre y URL vÃ¡lida son obligatorios." });
    }
    const cancion = agregarCancionMenu({ nombre: nombre.trim(), icono: String(icono), url, loop: !!loop });
    console.log(`ðŸŽµ CanciÃ³n aÃ±adida al menÃº: ${cancion.nombre} <${url}>`);
    res.json({ ok: true, cancion });
  });

  app.delete("/api/djgambit/menu/:id", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /djgambit vincular." });
    const id = Number(req.params.id);
    const borrada = borrarCancionMenu(id);
    if (!borrada) return res.status(404).json({ ok: false, error: "CanciÃ³n no encontrada." });
    console.log(`ðŸŽµ CanciÃ³n ${id} quitada del menÃº.`);
    res.json({ ok: true });
  });

  // ---------- ReproducciÃ³n (se vincula al guild por el token) ----------

  app.post("/api/djgambit/play", (req, res) => {
    const guildId = guildDeToken(req);
    const { id } = req.body ?? {};
    const cancion = id ? getCancionMenu(Number(id)) : null;
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /djgambit vincular." });
    if (!cancion) return res.status(404).json({ ok: false, error: "CanciÃ³n no encontrada en el menÃº." });

    setImmediate(() => {
      reproducirConSesion(req, res, guildId, cancion);
    });
  });

  app.post("/api/djgambit/stop", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /djgambit vincular." });
    const parada = pararCancionMenu(guildId);
    res.json({ ok: true, parada });
  });

  app.get("/api/djgambit/estado", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /djgambit vincular." });
    res.json({ ok: true, ...estadoCancionMenu(guildId) });
  });

  // EstÃ¡ticos del panel compilado (Owlbear carga manifest.json desde aquÃ­)
  if (existsSync(resolve(DJGAMBIT_DIR))) {
    app.use(express.static(resolve(DJGAMBIT_DIR)));
  }

  // Rutas temporales registradas (p. ej. /callback de OAuth Twitch)
  app.use((req, res, next) => {
    const manejador = rutasTemporales.get(req.path);
    if (manejador) manejador(req, res);
    else next();
  });

  // 404 para lo demÃ¡s
  app.use((_req, res) => res.status(404).send("Nada por aquÃ­."));

  return app;
}

export function iniciarPuenteDjgambit(client) {
  if (!DJGAMBIT_PORT || !process.env.DJGAMBIT_SLUG) {
    console.log("ðŸŽµ Servidor unificado desactivado (define DJGAMBIT_PORT y DJGAMBIT_SLUG en .env).");
    return null;
  }
  clienteActual = client;
  const app = crearAppDjgambit();
  const servidor = app.listen(DJGAMBIT_PORT, () => {
    servidorActivo = servidor;
    console.log(`ðŸŽµ Servidor unificado (menÃº DJGambit + OAuth Twitch) escuchando en localhost:${DJGAMBIT_PORT} âœ“`);
    if (!existsSync(resolve(DJGAMBIT_DIR))) {
      console.warn(`ðŸŽµ Aviso: ${DJGAMBIT_DIR} no existe (compila el panel de DJGambit y sÃºbelo a la Pi para servir el manifest).`);
    }
  });
  return servidor;
}

export function detenerPuenteDjgambit() {
  if (servidorActivo) {
    try { servidorActivo.close(); } catch {}
    servidorActivo = null;
  }
}
