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

// Puente HTTP Djinni → Discord.
// - El panel (navegador del DM dentro de Owlbear) se vincula con un código de
//   verificación y luego maneja el menú global de canciones: añadir, quitar y
//   reproducir — el audio suena SOLO en el bot, nunca en el navegador.
// - Se sirve el build estático del panel con CORS porque Owlbear Rodeo carga
//   la extensión desde otro origen (owlbear.rodeo).
// Sin puertos abiertos: sale por el túnel de Cloudflare.

const DJINNI_PORT = Number(process.env.DJINNI_PORT || 0);
const DJINNI_DIR = process.env.DJINNI_DIR || "src/djinni/build";

const TTL_CODIGO_MS = 10 * 60 * 1000; // el código de verificación dura 10 min
const codigos = new Map(); // codigo -> { guildId, expira }
let clienteActual = null; // client de discord.js (para unir al canal al reproducir)

// ---------- Rutas temporales (callbacks OAuth de Twitch) ----------
// El mismo servidor sirve la música y los callbacks de /sincronizar twitch,
// así SOLO hace falta UN túnel/puerto. twitch.js registra aquí su callback.

const rutasTemporales = new Map(); // path -> manejador(req, res)
let servidorActivo = null;

export function puenteListo() {
  return servidorActivo !== null;
}

/**
 * Registra una ruta temporal (GET) que resuelve una promesa con el resultado
 * del manejador. manejador(url) → { status, html, valor? , rechazar? }
 */
export function registrarRutaTemporal(path, { timeoutMs = 5 * 60_000, manejador } = {}) {
  if (rutasTemporales.has(path)) {
    throw new Error(`Ya hay una espera activa para ${path}`);
  }
  const promesa = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rutasTemporales.delete(path);
      reject(new Error(`Se agotó el tiempo de espera (${Math.round(timeoutMs / 60000)} min). Vuelve a usar el comando.`));
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
        try { res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }); res.end("<p>❌ Error interno.</p>"); } catch {}
        reject(error);
      }
    });
  });
  // Evita unhandledRejection si rechaza antes de que el consumidor haga await
  promesa.catch(() => {});
  return { promesa };
}

/**
 * Genera un código de verificación de un solo uso para vincular el panel a un
 * servidor de Discord. Lo crea el comando /djinni vincular.
 */
export function generarCodigoVinculacion(guildId) {
  // Limpia códigos caducados de la misma guild
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
 * Reprocha una canción del menú en el guild vinculado. Si el bot no está en el
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
        console.error(`🎵 No pude unir el bot para el menú en ${guildId}:`, error.message);
      }
    }
  }

  if (!getSesion(guildId)) {
    return res.status(409).json({
      ok: false,
      error: "El bot no está en un canal de voz. Conecta el bot con /musica unir y vuelve a pulsar.",
    });
  }

  try {
    const creado = reproducirCancionMenu(guildId, {
      id: cancion.id,
      url: cancion.url,
      nombre: cancion.nombre,
      loop: cancion.loop,
    });
    if (!creado) return res.status(409).json({ ok: false, error: "No hay sesión de voz activa." });
    await creado.promesa;
    res.json({ ok: true, cancion: { id: cancion.id, nombre: cancion.nombre, url: cancion.url } });
  } catch (error) {
    console.error(`🎵 Error reproduciendo ${cancion.nombre}:`, error.message);
    res.status(502).json({ ok: false, error: `No pude reproducir esa canción: ${error.message}` });
  }
}

export function crearAppDjinni() {
  const app = express();
  app.disable("x-powered-by");

  // CORS: Owlbear Rodeo carga la extensión desde owlbear.rodeo (origen cruzado)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.text({ type: "text/plain", limit: "128kb" })); // para sendBeacon al cerrar la pestaña
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, nombre: "taberna-mago djinni bridge", canciones: listarCancionesMenu().length });
  });

  // ---------- Vinculación con código ----------
  // El DM genera un código con /djinni vincular y lo introduce en el panel.
  app.post("/api/djinni/vincula", (req, res) => {
    const codigo = String(req.body?.codigo ?? "").trim();
    const info = codigos.get(codigo);
    if (!info || info.expira < Date.now()) {
      if (info) codigos.delete(codigo);
      return res.status(401).json({ ok: false, error: "Código inválido o caducado. Genera uno nuevo con /djinni vincular." });
    }
    codigos.delete(codigo); // un solo uso
    const token = randomBytes(24).toString("hex");
    setGuildPorToken(token, info.guildId);
    const guild = clienteActual?.guilds.cache.get(info.guildId);
    res.json({ ok: true, token, guildId: info.guildId, guildName: guild?.name ?? "" });
  });

  // ---------- Menú global de canciones ----------

  app.get("/api/djinni/menu", (_req, res) => {
    res.json({ ok: true, canciones: listarCancionesMenu() });
  });

  app.post("/api/djinni/menu", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /djinni vincular." });
    const { nombre, icono = "", url = "", loop = false } = req.body ?? {};
    if (!nombre?.trim() || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "Nombre y URL válida son obligatorios." });
    }
    const cancion = agregarCancionMenu({ nombre: nombre.trim(), icono: String(icono), url, loop: !!loop });
    console.log(`🎵 Canción añadida al menú: ${cancion.nombre} <${url}>`);
    res.json({ ok: true, cancion });
  });

  app.delete("/api/djinni/menu/:id", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /djinni vincular." });
    const id = Number(req.params.id);
    const borrada = borrarCancionMenu(id);
    if (!borrada) return res.status(404).json({ ok: false, error: "Canción no encontrada." });
    console.log(`🎵 Canción ${id} quitada del menú.`);
    res.json({ ok: true });
  });

  // ---------- Reproducción (se vincula al guild por el token) ----------

  app.post("/api/djinni/play", (req, res) => {
    const guildId = guildDeToken(req);
    const { id } = req.body ?? {};
    const cancion = id ? getCancionMenu(Number(id)) : null;
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /djinni vincular." });
    if (!cancion) return res.status(404).json({ ok: false, error: "Canción no encontrada en el menú." });

    setImmediate(() => {
      reproducirConSesion(req, res, guildId, cancion);
    });
  });

  app.post("/api/djinni/stop", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /djinni vincular." });
    const parada = pararCancionMenu(guildId);
    res.json({ ok: true, parada });
  });

  app.get("/api/djinni/estado", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /djinni vincular." });
    res.json({ ok: true, ...estadoCancionMenu(guildId) });
  });

  // Estáticos del panel compilado (Owlbear carga manifest.json desde aquí)
  if (existsSync(resolve(DJINNI_DIR))) {
    app.use(express.static(resolve(DJINNI_DIR)));
  }

  // Rutas temporales registradas (p. ej. /callback de OAuth Twitch)
  app.use((req, res, next) => {
    const manejador = rutasTemporales.get(req.path);
    if (manejador) manejador(req, res);
    else next();
  });

  // 404 para lo demás
  app.use((_req, res) => res.status(404).send("Nada por aquí."));

  return app;
}

export function iniciarPuenteDjinni(client) {
  if (!DJINNI_PORT || !process.env.DJINNI_SLUG) {
    console.log("🎵 Servidor unificado desactivado (define DJINNI_PORT y DJINNI_SLUG en .env).");
    return null;
  }
  clienteActual = client;
  const app = crearAppDjinni();
  const servidor = app.listen(DJINNI_PORT, () => {
    servidorActivo = servidor;
    console.log(`🎵 Servidor unificado (menú Djinni + OAuth Twitch) escuchando en localhost:${DJINNI_PORT} ✓`);
    if (!existsSync(resolve(DJINNI_DIR))) {
      console.warn(`🎵 Aviso: ${DJINNI_DIR} no existe (compila el panel de Djinni y súbelo a la Pi para servir el manifest).`);
    }
  });
  return servidor;
}

export function detenerPuenteDjinni() {
  if (servidorActivo) {
    try { servidorActivo.close(); } catch {}
    servidorActivo = null;
  }
}
