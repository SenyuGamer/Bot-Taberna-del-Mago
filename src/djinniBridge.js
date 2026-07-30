import express from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { aplicarEstadoDjinniGlobal, listarSesiones } from "./voice/sessionManager.js";

// Puente HTTP Djinni → Discord.
// - La extensión (navegador del DM) hace POST del estado de reproducción.
// - Se sirve el build estático del fork (manifest.json incluido) con CORS porque
//   Owlbear Rodeo carga la extensión desde otro origen (owlbear.rodeo).
// Sin puertos abiertos: sale por el túnel de Cloudflare.

const DJINNI_PORT = Number(process.env.DJINNI_PORT || 0);
const DJINNI_SLUG = process.env.DJINNI_SLUG || "";
const DJINNI_DIR = process.env.DJINNI_DIR || "src/djinni/build";

const intervaloRateLimit = new Map(); // ip -> ts último POST útil
let ultimoHash = "";
let ultimoHashTs = 0;
const hashDe = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");

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

export function crearAppDjinni() {
  const app = express();
  app.disable("x-powered-by");

  // CORS: Owlbear Rodeo carga la extensión desde owlbear.rodeo (origen cruzado)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.text({ type: "text/plain", limit: "128kb" })); // para sendBeacon al cerrar la pestaña
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, nombre: "taberna-mago djinni bridge", sesiones: listarSesiones() });
  });

  app.post(`/api/state/${DJINNI_SLUG}`, (req, res) => {
    let estado = req.body;
    if (typeof estado === "string") {
      try { estado = JSON.parse(estado || "{}"); } catch { estado = null; }
    }
    if (!estado || typeof estado !== "object" || Array.isArray(estado)) {
      return res.status(400).json({ ok: false, error: "cuerpo inválido" });
    }

    const ahora = Date.now();

    // Dedup primero: varios navegadores del mismo Owlbear pueden enviar el mismo
    // estado a la vez — se responde "duplicado" sin gastar rate limit.
    const hash = hashDe(estado);
    if (hash === ultimoHash && ahora - ultimoHashTs < 3000) {
      return res.status(200).json({ ok: true, duplicado: true });
    }

    // Rate limit global blando: máx. 1 POST útil por segundo (payloads nuevos)
    const ip = req.ip ?? "desconocida";
    const anterior = intervaloRateLimit.get(ip) ?? 0;
    if (ahora - anterior < 1000) return res.status(429).json({ ok: false, error: "rate limit" });
    intervaloRateLimit.set(ip, ahora);

    ultimoHash = hash;
    ultimoHashTs = ahora;

    res.status(202).json({ ok: true });
    // Asíncrono: no bloqueamos la respuesta con arranques de tuberías
    setImmediate(() => {
      try {
        aplicarEstadoDjinniGlobal(estado);
      } catch (error) {
        console.error("🎵 Error aplicando estado Djinni:", error);
      }
    });
  });

  // Estáticos del fork compilado (Owlbear carga manifest.json desde aquí)
  if (existsSync(resolve(DJINNI_DIR))) {
    app.use(express.static(resolve(DJINNI_DIR)));
  }

  // Rutas temporales registradas (p. ej. /callback de OAuth Twitch)
  app.use((req, res, next) => {
    const manejador = rutasTemporales.get(req.path);
    if (manejador) manejador(req, res);
    else next();
  });

  // 404 para lo demás (incluye slugs equivocados: no revelamos el bueno)
  app.use((_req, res) => res.status(404).send("Nada por aquí."));

  return app;
}

export function iniciarPuenteDjinni({ puerto = DJINNI_PORT } = {}) {
  if (!puerto || !DJINNI_SLUG) {
    console.log("🎵 Servidor unificado desactivado (define DJINNI_PORT y DJINNI_SLUG en .env).");
    return null;
  }
  const app = crearAppDjinni();
  const servidor = app.listen(puerto, () => {
    servidorActivo = servidor;
    const real = servidor.address().port;
    console.log(`🎵 Servidor unificado (música + OAuth Twitch) escuchando en localhost:${real} ✓`);
    if (!existsSync(resolve(DJINNI_DIR))) {
      console.warn(`🎵 Aviso: ${DJINNI_DIR} no existe (compila el fork de Djinni y súbelo a la Pi para servir el manifest).`);
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
