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
  actualizarCancionMenu,
  setOrdenCancionesMenu,
} from "./db.js";
import { reproducirCancionMenu, reproducirPlaylistCategoria, pararCancionMenu, estadoCancionMenu, getSesion, unir, canalGuardado, setOnCambioSonando } from "./voice/sessionManager.js";
import { precargarCache, existeCache, borrarCache, estadoCache, vaciarCache, podarCache } from "./voice/pipeline.js";

// Precargas en curso por URL (evita descargar la misma canciÃ³n dos veces a la vez).
const precargas = new Map(); // url -> Promise

/** Lanza la descarga a cachÃ© de una URL (reutilizando la que ya estÃ© en curso). */
export function _asegurarPrecarga(url) {
  let promesa = precargas.get(url);
  if (!promesa) {
    promesa = precargarCache({ url });
    promesa.finally(() => precargas.delete(url)).catch(() => {});
    precargas.set(url, promesa);
  }
  return promesa;
}

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
 * servidor de Discord. Lo crea el comando /musica vincular.
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

/** Añade https:// si falta el esquema al pegar la URL (p. ej. "youtube.com/..."). */
function normalizarUrl(url) {
  const u = String(url ?? "").trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return `https://${u}`;
  return u;
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
async function reproducirConSesion(req, res, guildId, cancion, crossfadeMs = 0, loop = false, loopCategoria = false) {
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
    let creado;
    if (cancion.categoria && loopCategoria) {
      // Modo lista de reproducción: suena toda la categoría en bucle empezando por esa canción.
      const canciones = listarCancionesMenu().filter((c) => c.categoria === cancion.categoria);
      creado = reproducirPlaylistCategoria(guildId, {
        categoria: cancion.categoria,
        canciones,
        inicioId: cancion.id,
      });
    } else {
      creado = reproducirCancionMenu(guildId, {
        id: cancion.id,
        url: cancion.url,
        nombre: cancion.nombre,
        loop,
        crossfadeMs,
      });
    }
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
  // El DM genera un cÃ³digo con /musica vincular y lo introduce en el panel.
  app.post("/api/djgambit/vincula", (req, res) => {
    const codigo = String(req.body?.codigo ?? "").trim();
    const info = codigos.get(codigo);
    if (!info || info.expira < Date.now()) {
      if (info) codigos.delete(codigo);
      return res.status(401).json({ ok: false, error: "CÃ³digo invÃ¡lido o caducado. Genera uno nuevo con /musica vincular." });
    }
    codigos.delete(codigo); // un solo uso
    const token = randomBytes(24).toString("hex");
    setGuildPorToken(token, info.guildId);
    const guild = clienteActual?.guilds.cache.get(info.guildId);
    res.json({ ok: true, token, guildId: info.guildId, guildName: guild?.name ?? "" });
  });

  // ---------- MenÃº global de canciones ----------

  app.get("/api/djgambit/menu", (_req, res) => {
    const canciones = listarCancionesMenu().map((c) => ({
      ...c,
      cacheado: existeCache({ url: c.url }),
      cacheando: precargas.has(c.url),
    }));
    res.json({ ok: true, canciones });
  });

app.post("/api/djgambit/menu", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const { nombre, icono = "", categoria = "" } = req.body ?? {};
    const url = normalizarUrl(req.body?.url ?? "");
    if (!nombre?.trim() || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "Nombre y URL válida son obligatorios." });
    }
    const cancion = agregarCancionMenu({ nombre: nombre.trim(), icono: String(icono), url, categoria: String(categoria) });
    console.log(`ðŸŽµ CanciÃ³n aÃ±adida al menÃº: ${cancion.nombre} <${url}>`);

    // Auto-cachÃ©: se descarga a disco en segundo plano (sin bloquear el panel).
    _asegurarPrecarga(url).then(
      (r) => console.log(`ðŸŽµ PrÃ©-cachÃ© automÃ¡tico lista: ${cancion.nombre}${r.yaExistia ? " (ya estaba)" : ""}`),
      (error) => console.error(`ðŸŽµ No se pudo auto-cachÃ© ${cancion.nombre}:`, error.message)
    );

    res.json({ ok: true, cancion: { ...cancion, cacheado: existeCache({ url }), cacheando: true } });
  });

app.delete("/api/djgambit/menu/:id", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const id = Number(req.params.id);
    const cancion = getCancionMenu(id);
    const borrada = borrarCancionMenu(id);
    if (!borrada) return res.status(404).json({ ok: false, error: "Canción no encontrada." });
    if (cancion) borrarCache({ url: cancion.url }); // borrar también la copia en caché
    console.log(`🎵 Canción ${id} quitada del menú (y de la caché).`);
    res.json({ ok: true });
  });

  // ---------- Editar / reordenar / exportar / importar el menú ----------

  app.patch("/api/djgambit/menu/:id", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const id = Number(req.params.id);
    const actual = getCancionMenu(id);
    if (!actual) return res.status(404).json({ ok: false, error: "Canción no encontrada." });
    const { nombre, icono, categoria, loop } = req.body ?? {};
    const urlEntrante = normalizarUrl(req.body?.url);
    const nuevaUrl = /^https?:\/\//i.test(urlEntrante) ? urlEntrante : actual.url;
    const nueva = actualizarCancionMenu(id, {
      nombre: typeof nombre === "string" && nombre.trim() ? nombre.trim() : actual.nombre,
      icono: typeof icono === "string" ? icono : actual.icono,
      url: nuevaUrl,
      loop: typeof loop === "boolean" ? loop : actual.loop,
      categoria: typeof categoria === "string" ? categoria : actual.categoria,
    });
    if (!nueva) return res.status(500).json({ ok: false, error: "No se pudo actualizar la canción." });
    if (nuevaUrl !== actual.url) {
      // La caché de la URL antigua ya no sirve: se borra y se cachea la nueva.
      borrarCache({ url: actual.url });
      _asegurarPrecarga(nuevaUrl).then(
        () => console.log(`🎵 Pré-caché de la canción editada <${nueva.nombre}> listo.`),
        (e) => console.error(`🎵 No se pudo auto-caché (edición) <${nueva.nombre}>:`, e.message)
      );
    }
    res.json({ ok: true, cancion: { ...nueva, cacheado: existeCache({ url: nueva.url }), cacheando: precargas.has(nueva.url) } });
  });

  app.post("/api/djgambit/menu/orden", (req, res) => {
    if (!guildDeToken(req)) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false, error: "Faltan ids a reordenar." });
    const reordenadas = setOrdenCancionesMenu(ids);
    res.json({ ok: true, reordenadas });
  });

  app.get("/api/djgambit/menu/exportar", (_req, res) => {
    const guildId = guildDeToken(_req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const canciones = listarCancionesMenu().map(({ id, ...c }) => c);
    res.json({ ok: true, canciones });
  });

  app.post("/api/djgambit/menu/importar", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const { canciones } = req.body ?? {};
    if (!Array.isArray(canciones) || canciones.length === 0) {
      return res.status(400).json({ ok: false, error: "Faltan canciones a importar." });
    }
    const existentes = new Set(listarCancionesMenu().map((c) => c.url));
    let agregadas = 0;
    let omitidas = 0;
    for (const c of canciones) {
      const nombre = String(c?.nombre ?? "").trim();
      const url = String(c?.url ?? "").trim();
      if (!nombre || !/^https?:\/\//i.test(url)) continue;
      if (existentes.has(url)) { omitidas++; continue; }
      agregarCancionMenu({ nombre, icono: String(c?.icono ?? ""), url, loop: !!c?.loop, categoria: String(c?.categoria ?? "") });
      existentes.add(url);
      _asegurarPrecarga(url).catch(() => {});
      agregadas++;
    }
    console.log(`🎵 Menú importado: ${agregadas} añadidas, ${omitidas} omitidas (ya existían).`);
    res.json({ ok: true, agregadas, omitidas });
  });

  // ---------- Caché: estado, vaciar y podar ----------

  app.get("/api/djgambit/cache", (_req, res) => {
    const guildId = guildDeToken(_req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const urls = listarCancionesMenu().map((c) => c.url);
    res.json({ ok: true, ...estadoCache({ urls }), cacheando: [...precargas.keys()] });
  });

  app.post("/api/djgambit/cache/vaciar", (_req, res) => {
    const guildId = guildDeToken(_req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const eliminados = vaciarCache();
    console.log(`🎵 Caché vaciada: ${eliminados} archivos eliminados.`);
    res.json({ ok: true, eliminados });
  });

  app.post("/api/djgambit/cache/podar", (_req, res) => {
    const guildId = guildDeToken(_req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado. Usa /musica vincular." });
    const urls = listarCancionesMenu().map((c) => c.url);
    const resultado = podarCache({ urls });
    console.log(`🎵 Caché podada: ${resultado.huerfanos} huérfanas y ${resultado.parciales} parciales viejas eliminadas.`);
    res.json({ ok: true, ...resultado });
  });

  // ---------- ReproducciÃ³n (se vincula al guild por el token) ----------

  app.post("/api/djgambit/play", (req, res) => {
    const guildId = guildDeToken(req);
    const { id, crossfade = 0, loop = false, loopCategoria = false } = req.body ?? {};
    const cancion = id ? getCancionMenu(Number(id)) : null;
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /musica vincular." });
    if (!cancion) return res.status(404).json({ ok: false, error: "CanciÃ³n no encontrada en el menÃº." });

    setImmediate(() => {
      const ms = Number(crossfade) > 0 ? Number(crossfade) * 1000 : 0;
      reproducirConSesion(req, res, guildId, cancion, ms, !!loop, !!loopCategoria);
    });
  });

  app.post("/api/djgambit/stop", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /musica vincular." });
    const parada = pararCancionMenu(guildId);
    res.json({ ok: true, parada });
  });

  app.get("/api/djgambit/estado", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /musica vincular." });
    const estado = estadoCancionMenu(guildId);
    const cache = estadoCache({ urls: listarCancionesMenu().map((c) => c.url) });
    res.json({ ok: true, ...estado, cacheando: [...precargas.keys()], cache });
  });

  app.post("/api/djgambit/volumen", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /musica vincular." });
    const v = Number(req.body?.v);
    if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ ok: false, error: "v debe estar entre 0 y 100." });
    const s = getSesion(guildId);
    if (!s) return res.status(409).json({ ok: false, error: "No hay sesión de voz activa.", volumen: 100 });
    s.mixer.setVolumenGlobal(v / 100);
    res.json({ ok: true, volumen: v });
  });

  // ---------- PrÃ©-cachÃ© de todo el menÃº (descarga en segundo plano) ----------

  app.post("/api/djgambit/precache-all", (req, res) => {
    const guildId = guildDeToken(req);
    if (!guildId) return res.status(401).json({ ok: false, error: "Panel no vinculado a un servidor. Usa /musica vincular." });
    const canciones = listarCancionesMenu();
    const porCachear = canciones.filter((c) => !existeCache({ url: c.url }));
    let enCurso = 0;
    for (const c of porCachear) {
      if (precargas.has(c.url)) continue;
      _asegurarPrecarga(c.url).then(
        (r) => console.log(`ðŸŽµ CachÃ© de <${c.nombre}>${r.yaExistia ? " (ya estaba)" : " lista"}`),
        (error) => console.error(`ðŸŽµ No se pudo cachear <${c.nombre}>:`, error.message)
      );
      enCurso++;
    }
    console.log(`ðŸŽµ PrÃ©-cachÃ© global: ${enCurso} enlazadas (${canciones.length - porCachear.length} ya en cachÃ©).`);
    res.json({ ok: true, total: canciones.length, enCurso, yaEnCache: canciones.length - porCachear.length });
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
    console.log("🎵 Servidor unificado desactivado (define DJGAMBIT_PORT y DJGAMBIT_SLUG en .env).");
    return null;
  }
  clienteActual = client;
  // Presencia del bot mientras suena una canción del menú.
  setOnCambioSonando((nombre) => {
    if (!clienteActual?.user) return;
    clienteActual.user.setActivity(nombre ? `🔊 Sonando: ${nombre}` : null).catch(() => {});
  });
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
