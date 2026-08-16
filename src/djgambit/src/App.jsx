import "./App.css";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import OBR from "@owlbear-rodeo/sdk";

// Panel "DJGAMBIT · Taberna del Mago" para el DM.
// - Solo se muestra al GM (la extensión, vista del DM).
// - Se vincula a un servidor de Discord con un código (/musica vincular).
// - Muestra el menú global de canciones agrupado por categorías (tarjetas con
//   icono encima y nombre debajo, como en la app original de DJGAMBIT).
// - Clic en una tarjeta → suena SOLO en el bot de Discord (nunca aquí).
// - Caché automática al añadir; ✓ en la tarjeta cuando está guardada.
// - 🔁 por canción: repetir. ↻ por categoría: playlist en bucle.
// - Drag & drop para reordenar dentro de la categoría; ✏ editar; 🔍 buscar.
// - Volumen de sesión, timeline de lo que suena, exportar/importar menú (JSON)
//   y gestión de la caché (podar huérfanas / vaciar todo).

const API = ""; // relativo: el panel se sirve desde el mismo túnel que el bridge

const ESTADOS = {
  CARGANDO: "cargando",
  NO_GM: "no-gm",
  NO_VINCULADO: "no-vinculado",
  LISTO: "listo",
};

// Emojis predefinidos para el icono de cada canción.
const EMOJIS = [
  "🎵", "🎶", "🎸", "🥁", "🎹", "🎻", "🎺", "🎷", "🎤", "🎧", "🎼", "📻",
  "🪕", "🪗", "🪘", "🎯", "🔥", "🍺", "🧙", "🛡️", "⚔️", "🐉", "✨", "🌙",
  "🏮", "📜",
];

function api(token) {
  return async (ruta, opciones = {}) => {
    const headers = { "Content-Type": "application/json", ...(opciones.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${ruta}`, { ...opciones, headers });
    const datos = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(datos.error ?? `Error ${res.status}`);
    return datos;
  };
}

function formatearTiempo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatearBytes(n) {
  if (!Number.isFinite(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// Añade https:// si al pegar la URL falta el esquema (p. ej. "youtube.com/...").
function normalizarUrl(url) {
  const u = String(url ?? "").trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return `https://${u}`;
  return u;
}

export default function App() {
  const [estado, setEstado] = useState(ESTADOS.CARGANDO);
  const [token, setToken] = useState(() => localStorage.getItem("djgambit_token") || "");
  const [codigo, setCodigo] = useState("");
  const [canciones, setCanciones] = useState([]);
  const [sonando, setSonando] = useState(null); // { id, nombre, inicioEn, duracionMs }
  const [guildName, setGuildName] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const [vinculando, setVinculando] = useState(false);
  const [cargandoId, setCargandoId] = useState(null); // id de la canción en proceso
  const [mostrarForm, setMostrarForm] = useState(false);
  const [editando, setEditando] = useState(null); // canción siendo editada
  const [nueva, setNueva] = useState({ nombre: "", icono: "", url: "", categoria: "" });
  const [busqueda, setBusqueda] = useState("");
  const [volumen, setVolumen] = useState(100);
  const [cacheInfo, setCacheInfo] = useState(null); // { total, tamañoBytes, huerfanos, cacheando }
  const [crossfadeS, setCrossfadeS] = useState(() => Number(localStorage.getItem("djgambit_crossfade_s")) || 0); // segundos (0 = off)
  const [loops, setLoops] = useState(() => JSON.parse(localStorage.getItem("djgambit_loops") || "{}")); // id -> bool
  const [cats, setCats] = useState(() => JSON.parse(localStorage.getItem("djgambit_cats") || "{}")); // categoria -> bool (playlist)
  const [mostrarEmojis, setMostrarEmojis] = useState(false);
  const [arrastrando, setArrastrando] = useState(null); // { cat, id }
  const [destacadaId, setDestacadaId] = useState(null); // canción recién añadida (para resaltarla)

  const ultimoJson = useRef("");
  const volumenAjustando = useRef(false);
  const volumenTimer = useRef(null);
  const archivoImportRef = useRef(null);

  const sincronizar = useCallback(async () => {
    if (!token) return;
    const f = api(token);
    try {
      const [menuR, estR] = await Promise.allSettled([f("/api/djgambit/menu"), f("/api/djgambit/estado")]);
      if (menuR.status === "rejected") throw menuR.reason;
      const canc = menuR.value.canciones ?? [];
      const est = estR.status === "fulfilled" ? estR.value : null;
      const sig = JSON.stringify({
        canc,
        sonando: est?.sonando ? { id: est.cancionId, nombre: est.nombre, inicioEn: est.inicioEn, duracionMs: est.duracionMs } : null,
        cache: est?.cache ?? null,
        cacheando: est?.cacheando ?? [],
        vol: est?.volumen ?? 100,
      });
      if (sig !== ultimoJson.current) {
        ultimoJson.current = sig;
        setCanciones(canc);
        if (est) {
          setSonando(est.sonando ? { id: est.cancionId, nombre: est.nombre, inicioEn: est.inicioEn, duracionMs: est.duracionMs } : null);
          setCacheInfo({ ...(est.cache ?? {}), cacheando: (est.cacheando ?? []).length });
          if (!volumenAjustando.current) setVolumen(est.volumen ?? 100);
        }
      }
    } catch (e) {
      if (/vinculado/i.test(e.message)) {
        localStorage.removeItem("djgambit_token");
        setToken("");
        setEstado(ESTADOS.NO_VINCULADO);
      }
    }
  }, [token]);

  useEffect(() => {
    OBR.onReady(async () => {
      let rol = "";
      try {
        rol = await OBR.player.getRole();
      } catch {} // eslint-disable-line no-empty
      if (rol !== "GM") {
        OBR.action.setWidth(240);
        OBR.action.setHeight(120);
        setEstado(ESTADOS.NO_GM);
        return;
      }
      OBR.action.setWidth(640);
      OBR.action.setHeight(500);
      setEstado(token ? ESTADOS.LISTO : ESTADOS.NO_VINCULADO);
      if (token) sincronizar();
    });
  }, [token, sincronizar]);

  // Refresco periódico leve: caché (guardando → hecho), sonando, timeline, caché.
  useEffect(() => {
    if (estado !== ESTADOS.LISTO || !token) return;
    const id = setInterval(() => sincronizar(), 4000);
    return () => clearInterval(id);
  }, [estado, token, sincronizar]);

  // Re-render cada segundo mientras suena, para mover el timeline suave.
  const [, setTic] = useState(0);
  useEffect(() => {
    if (!sonando) return;
    const id = setInterval(() => setTic((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [sonando]);

  async function vincular() {
    setVinculando(true);
    setError("");
    try {
      const datos = await api()("/api/djgambit/vincula", {
        method: "POST",
        body: JSON.stringify({ codigo: codigo.trim() }),
      });
      localStorage.setItem("djgambit_token", datos.token);
      setToken(datos.token);
      setGuildName(datos.guildName ?? "");
      setEstado(ESTADOS.LISTO);
      await sincronizar();
    } catch (e) {
      setError(e.message);
    } finally {
      setVinculando(false);
    }
  }

  function desvincular() {
    localStorage.removeItem("djgambit_token");
    setToken("");
    setEstado(ESTADOS.NO_VINCULADO);
  }

  async function reproducir(id, nombre, categoria) {
    setCargandoId(id);
    setError("");
    setMensaje("");
    try {
      const catLoop = categoria ? !!cats[categoria] : false;
      const body = { id, crossfade: crossfadeS };
      if (catLoop) {
        body.loopCategoria = true; // suena toda la categoría en bucle desde esta canción
      } else {
        body.loop = !!loops[id]; // repetir esta canción
      }
      await api(token)("/api/djgambit/play", { method: "POST", body: JSON.stringify(body) });
      setSonando({ id, nombre, inicioEn: Date.now(), duracionMs: null });
      setMensaje(`✓ Sonando: ${nombre}${catLoop ? ` · ${categoria} ↻` : loops[id] ? " · 🔁" : ""}`);
      await sincronizar();
    } catch (e) {
      setError(e.message);
    } finally {
      setCargandoId(null);
    }
  }

  function cambiarCrossfade(v) {
    setCrossfadeS(v);
    localStorage.setItem("djgambit_crossfade_s", String(v));
  }

  function cambiarVolumen(v) {
    setVolumen(v);
    volumenAjustando.current = true;
    clearTimeout(volumenTimer.current);
    volumenTimer.current = setTimeout(async () => {
      try {
        const d = await api(token)("/api/djgambit/volumen", { method: "POST", body: JSON.stringify({ v }) });
        setVolumen(d.volumen ?? v);
      } catch (e) {
        setError(e.message);
      } finally {
        volumenAjustando.current = false;
      }
    }, 300);
  }

  function alternarLoopCancion(id) {
    setLoops((prev) => {
      const nuevo = { ...prev, [id]: !prev[id] };
      localStorage.setItem("djgambit_loops", JSON.stringify(nuevo));
      return nuevo;
    });
  }

  function alternarLoopCategoria(cat) {
    setCats((prev) => {
      const nuevo = { ...prev, [cat]: !prev[cat] };
      localStorage.setItem("djgambit_cats", JSON.stringify(nuevo));
      return nuevo;
    });
  }

  async function cachearTodas() {
    setError("");
    setMensaje("");
    try {
      const d = await api(token)("/api/djgambit/precache-all", { method: "POST", body: JSON.stringify({}) });
      setMensaje(
        d.enCurso > 0
          ? `⬇ Cacheando ${d.enCurso} canción(es) en segundo plano…`
          : `✓ Ya están todas en caché (${d.yaEnCache})`
      );
      await sincronizar();
    } catch (e) {
      setError(e.message);
    }
  }

  async function exportar() {
    setError("");
    setMensaje("");
    try {
      const d = await api(token)("/api/djgambit/menu/exportar");
      const blob = new Blob([JSON.stringify({ canciones: d.canciones }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "taberna-menu.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setMensaje(`⬇ Exportado el menú (${d.canciones.length} canciones).`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function importar(e) {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if (!archivo) return;
    setError("");
    setMensaje("");
    try {
      const texto = await archivo.text();
      const datos = JSON.parse(texto);
      const lista = Array.isArray(datos) ? datos : datos.canciones;
      if (!Array.isArray(lista)) throw new Error("Formato no reconocido (espera { canciones: [...] }).");
      const d = await api(token)("/api/djgambit/menu/importar", { method: "POST", body: JSON.stringify({ canciones: lista }) });
      setMensaje(`⬆ Importado: ${d.agregadas} añadidas, ${d.omitidas} omitidas (ya existían).`);
      await sincronizar();
    } catch (e) {
      setError(e.message);
    }
  }

  async function podar() {
    if (!confirm("¿Podar la caché? Se borrarán las huérfanas (ya no en el menú) y descargas abandonadas.")) return;
    setError("");
    setMensaje("");
    try {
      const d = await api(token)("/api/djgambit/cache/podar", { method: "POST", body: JSON.stringify({}) });
      setMensaje(`🧹 Caché podada: ${d.huerfanos} huérfanas y ${d.parciales} parciales viejas.`);
      await sincronizar();
    } catch (e) {
      setError(e.message);
    }
  }

  async function vaciar() {
    if (!confirm("¿Vaciar TODA la caché? Habrá que volver a descargar las canciones.")) return;
    setError("");
    setMensaje("");
    try {
      const d = await api(token)("/api/djgambit/cache/vaciar", { method: "POST", body: JSON.stringify({}) });
      setMensaje(`🧨 Caché vaciada (${d.eliminados} archivos).`);
      await sincronizar();
    } catch (e) {
      setError(e.message);
    }
  }

  async function parar() {
    setError("");
    setMensaje("");
    setCargandoId("detener");
    try {
      await api(token)("/api/djgambit/stop", { method: "POST", body: JSON.stringify({}) });
      setSonando(null);
      setMensaje("✓ Reproducción detenida");
      await sincronizar();
    } catch (e) {
      setError(e.message);
    } finally {
      setCargandoId(null);
    }
  }

  function abrirNueva() {
    setEditando(null);
    setNueva({ nombre: "", icono: "", url: "", categoria: "" });
    setMostrarForm(true);
    setMostrarEmojis(false);
  }

  function editar(c) {
    setEditando(c);
    setNueva({ nombre: c.nombre, icono: c.icono, url: c.url, categoria: c.categoria });
    setMostrarForm(true);
    setMostrarEmojis(false);
  }

  function cancelarForm() {
    setMostrarForm(false);
    setEditando(null);
    setNueva({ nombre: "", icono: "", url: "", categoria: "" });
    setMostrarEmojis(false);
  }

  async function guardar() {
    setError("");
    setMensaje("");
    const urlOk = normalizarUrl(nueva.url);
    if (!nueva.nombre.trim() || !/^https?:\/\//i.test(urlOk)) {
      setError("Escribe un nombre y una URL de YouTube válida (p. ej. https://www.youtube.com/watch?v=...).");
      return;
    }
    try {
      let idNuevo = null;
      if (editando) {
        await api(token)(`/api/djgambit/menu/${editando.id}`, { method: "PATCH", body: JSON.stringify({ ...nueva, url: urlOk }) });
        setMensaje("✓ Canción actualizada");
      } else {
        const d = await api(token)("/api/djgambit/menu", { method: "POST", body: JSON.stringify({ ...nueva, url: urlOk }) });
        idNuevo = d.cancion?.id ?? null;
        setMensaje("✓ Canción añadida");
      }
      cancelarForm();
      await sincronizar();
      if (idNuevo != null) {
        // Resalta y desplaza hasta la canción recién añadida.
        setDestacadaId(idNuevo);
        setTimeout(() => document.getElementById(`carta-${idNuevo}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 200);
        setTimeout(() => setDestacadaId((prev) => (prev === idNuevo ? null : prev)), 3000);
      }
    } catch (e) {
      setError(e.message);
    }
  }

  async function borrar(id) {
    setError("");
    setMensaje("");
    await api(token)(`/api/djgambit/menu/${id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    await sincronizar();
    if (sonando?.id === id) setSonando(null);
  }

  // Reordenar por drag & drop dentro de una categoría.
  function onDragStart(cat, id) {
    setArrastrando({ cat, id });
  }

  function onDragOver(e) {
    e.preventDefault();
  }

  function onDrop(cat, objetivoId = null) {
    if (!arrastrando) {
      setArrastrando(null);
      return;
    }
    const { cat: catOrigen, id } = arrastrando;
    setArrastrando(null);
    const nombreCat = (c) => c.categoria || "Sin categoría";
    const cancion = canciones.find((c) => c.id === id);
    if (!cancion) return;

    if (catOrigen === cat) {
      // Reordenar dentro de la misma categoría.
      if (objetivoId == null || objetivoId === id) return;
      const porId = new Map(canciones.map((c) => [c.id, c]));
      const ids = canciones.filter((c) => nombreCat(c) === cat).map((c) => c.id);
      const desde = ids.indexOf(id);
      const hasta = ids.indexOf(objetivoId);
      if (desde < 0 || hasta < 0) return;
      ids.splice(desde, 1);
      ids.splice(hasta, 0, id);
      const porCategoria = new Map();
      for (const c of canciones) {
        const k = nombreCat(c);
        if (!porCategoria.has(k)) porCategoria.set(k, []);
        porCategoria.get(k).push(c);
      }
      porCategoria.set(cat, ids.map((i) => porId.get(i)));
      setCanciones([...porCategoria.values()].flat());
      api(token)("/api/djgambit/menu/orden", { method: "POST", body: JSON.stringify({ ids }) }).catch((e) => setError(e.message));
      return;
    }

    // Mover la canción a otra categoría (se guarda la nueva categoría en el menú).
    const catDestino = cat === "Sin categoría" ? "" : cat;
    const nuevaLista = canciones.map((c) => (c.id === id ? { ...c, categoria: catDestino } : c));
    setCanciones(nuevaLista);
    const promesas = [
      api(token)(`/api/djgambit/menu/${id}`, { method: "PATCH", body: JSON.stringify({ categoria: catDestino }) }).catch((e) => setError(e.message)),
    ];
    // Si se soltó sobre una tarjeta concreta, insertarla en esa posición de la categoría destino.
    if (objetivoId != null && objetivoId !== id) {
      const ids = nuevaLista.filter((c) => nombreCat(c) === cat).map((c) => c.id);
      const desde = ids.indexOf(id);
      const hasta = ids.indexOf(objetivoId);
      if (desde >= 0 && hasta >= 0) {
        ids.splice(desde, 1);
        ids.splice(hasta, 0, id);
        promesas.push(api(token)("/api/djgambit/menu/orden", { method: "POST", body: JSON.stringify({ ids }) }).catch((e) => setError(e.message)));
      }
    }
    Promise.all(promesas).then(() => sincronizar()).catch(() => {});
  }

  // Agrupar canciones por categoría (respetando el orden) y filtrar por búsqueda.
  const grupos = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const orden = [];
    const mapa = new Map();
    for (const c of canciones) {
      if (q && ![c.nombre, c.categoria, c.icono].some((t) => String(t ?? "").toLowerCase().includes(q))) continue;
      const cat = c.categoria || "Sin categoría";
      if (!mapa.has(cat)) {
        mapa.set(cat, []);
        orden.push(cat);
      }
      mapa.get(cat).push(c);
    }
    return orden.map((cat) => ({ cat, items: mapa.get(cat) }));
  }, [canciones, busqueda]);

  const categoriasExistentes = useMemo(() => [...new Set(canciones.map((c) => c.categoria).filter(Boolean))], [canciones]);
  const cacheEnCurso = canciones.filter((c) => c.cacheando);
  const esSonando = (c) => sonando?.id === c.id;

  const posMs = sonando?.inicioEn ? Math.max(0, Date.now() - sonando.inicioEn) : 0;
  const durMs = sonando?.duracionMs ?? 0;
  const progresoPct = durMs > 0 ? Math.min(100, (posMs / durMs) * 100) : 0;

  if (estado === ESTADOS.CARGANDO) {
    return <div className="app-row"><span className="aviso">Cargando…</span></div>;
  }

  if (estado === ESTADOS.NO_GM) {
    return (
      <div className="app">
        <div className="app-row">
          <span className="titulo">🧞 DJGAMBIT</span>
          <span className="aviso">Solo el <b>DM</b> ve el menú musical.</span>
        </div>
      </div>
    );
  }

  if (estado === ESTADOS.NO_VINCULADO) {
    return (
      <div className="app">
        <span className="titulo">🧞 DJGAMBIT · Taberna del Mago</span>
        <p className="aviso">Pega el código de verificación de <code>/musica vincular</code> para enlazar este panel con el bot de Discord.</p>
        <input
          className="input"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="Código de 6 dígitos"
          inputMode="numeric"
        />
        <button className="boton boton-primario" onClick={vincular} disabled={vinculando || codigo.trim().length < 6}>
          {vinculando ? "Vinculando…" : "🔗 Vincular"}
        </button>
        {error && <span className="error">❌ {error}</span>}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="cab">
        <span className="titulo">🧞 Menú musical{guildName ? ` · ${guildName}` : ""}</span>
        <div className="cab-right">
          <div className="beta-badge" title="Versión experimental del panel — puede haber errores">BETA</div>
          <button className="boton boton-chico" onClick={cachearTodas} title="Descargar todas las canciones a caché" disabled={cargandoId !== null}>⬇</button>
          <button className="boton boton-chico" onClick={exportar} title="Exportar menú (JSON)">📤</button>
          <button className="boton boton-chico" onClick={() => archivoImportRef.current?.click()} title="Importar menú (JSON)">📥</button>
          <input ref={archivoImportRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={importar} />
          <div className="crossfade-control" title="Crossfade al cambiar de canción (segundos)">
            <span>🔀</span>
            <input
              type="range"
              min="0"
              max="10"
              step="0.5"
              value={crossfadeS}
              onChange={(e) => cambiarCrossfade(Number(e.target.value))}
            />
            <span className={`crossfade-val ${crossfadeS > 0 ? "activo" : ""}`}>{crossfadeS > 0 ? `${crossfadeS}s` : "off"}</span>
          </div>
          <button className="boton boton-chico" onClick={desvincular} title="Desvincular este panel">⏻</button>
        </div>
      </div>

      <div className="barra">
        <input
          className="input buscar"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="🔍 Buscar canción o categoría…"
        />
        <div className="volumen-control" title="Volumen de la sesión de voz del bot">
          <span>🔊</span>
          <input
            type="range"
            min="0"
            max="100"
            value={volumen}
            onChange={(e) => cambiarVolumen(Number(e.target.value))}
          />
          <span className="volumen-val">{volumen}%</span>
        </div>
        {cacheInfo && (
          <div className="cache-badge" title="Caché del bot en disco">
            <span>💾 {cacheInfo.total} · {formatearBytes(cacheInfo.tamañoBytes)}{cacheInfo.cacheando > 0 ? ` · ${cacheInfo.cacheando} ⬇` : ""}</span>
            {cacheInfo.huerfanos > 0 && <span className="cache-huerfanas"> · {cacheInfo.huerfanos} huérf.</span>}
            <button className="boton boton-chico" onClick={podar} title="Podar caché (huérfanas + descargas abandonadas)">🧹</button>
            <button className="boton boton-chico" onClick={vaciar} title="Vaciar toda la caché">🧨</button>
          </div>
        )}
      </div>

      <div className="mensajes">
        {cacheEnCurso.length > 0 && (
          <span className="ok cache-aviso"><span className="spinner spinner-mini" /> Guardando en caché: {cacheEnCurso.map((c) => c.nombre).join(", ")}…</span>
        )}
        {mensaje && <span className="ok">{mensaje}</span>}
        {error && <span className="error">❌ {error}</span>}
      </div>

      <div className="escenario">
        {grupos.map((g) => {
          const catLoop = !!cats[g.cat];
          return (
            <div className="cat" key={g.cat}>
              <div
                className={`cat-cab ${arrastrando ? "cat-cab-destino" : ""}`}
                onDragOver={onDragOver}
                onDrop={() => onDrop(g.cat, null)}
                title={arrastrando ? `Mover aquí (${g.cat})` : undefined}
              >
                <span className="cat-nombre">▸ {g.cat}</span>
                <label
                  className={`toggle toggle-cat ${catLoop ? "activa" : ""}`}
                  title={catLoop ? "Playlist de esta categoría activa (bucle)" : "Reproducir toda la categoría en bucle (playlist)"}
                >
                  <input type="checkbox" checked={catLoop} onChange={() => alternarLoopCategoria(g.cat)} />
                  <span className="cat-loop-ico">↻</span>
                </label>
              </div>
              <div className="cat-fila">
                {g.items.map((c) => {
                  const loop = !!loops[c.id];
                  return (
                    <div
                      key={c.id}
                      id={`carta-${c.id}`}
                      draggable
                      onDragStart={() => onDragStart(g.cat, c.id)}
                      onDragOver={onDragOver}
                      onDrop={() => onDrop(g.cat, c.id)}
                      className={`escena ${cargandoId === c.id ? "escena-cargando" : ""} ${esSonando(c) ? "escena-sonando" : ""} ${arrastrando?.id === c.id ? "escena-arrastrando" : ""} ${destacadaId === c.id ? "escena-destacada" : ""}`}
                    >
                      <button
                        className="escena-btn"
                        onClick={() => reproducir(c.id, c.nombre, c.categoria)}
                        disabled={cargandoId !== null && cargandoId !== c.id}
                        title={`${c.url}${loop ? "\n🔁 Repetir" : ""}`}
                      >
                        {cargandoId === c.id ? (
                          <span className="spinner" />
                        ) : (
                          <span className="icono">{c.icono || "🎵"}</span>
                        )}
                        {c.cacheado && !c.cacheando && <span className="cache-hecho" title="En caché">✓</span>}
                        {c.cacheando && (
                          <span className="cache-hecho" title="Guardando en caché…">
                            <span className="spinner spinner-mini" />
                          </span>
                        )}
                        <span className="escena-fila">
                          <span className="nombre">{c.nombre}</span>
                          <span className="badge">{esSonando(c) ? "▶" : ""}</span>
                        </span>
                      </button>
                      <button
                        className={`loop-btn ${loop ? "activo" : ""}`}
                        onClick={() => alternarLoopCancion(c.id)}
                        title={loop ? "Apagar bucle de esta canción" : "Repetir esta canción (bucle)"}
                      >
                        🔁
                      </button>
                      <button className="editar" onClick={() => editar(c)} title="Editar canción">✏</button>
                      <button className="basura" onClick={() => borrar(c.id)} title="Quitar del menú">🗑</button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <button className="boton boton-nueva" onClick={abrirNueva} disabled={cargandoId !== null}>
            ＋
          </button>
      </div>

      {mostrarForm && (
        <div className="form-overlay" onClick={cancelarForm}>
          <div className="form" onClick={(e) => e.stopPropagation()}>
            <div className="form-titulo">{editando ? "✏️ Editar canción" : "➕ Añadir canción"}</div>
            <div className="fila-emoji">
              <input className="input" value={nueva.icono} onChange={(e) => setNueva({ ...nueva, icono: e.target.value })} placeholder="Emoji" maxLength={8} />
              <button
                className="boton boton-chico"
                type="button"
                onClick={() => setMostrarEmojis((m) => !m)}
                title={mostrarEmojis ? "Ocultar emojis" : "Elegir un emoji de la lista"}
              >
                😀
              </button>
            </div>
            {mostrarEmojis && (
              <div className="emoji-picker">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="emoji-opcion"
                    onClick={() => {
                      setNueva({ ...nueva, icono: e });
                      setMostrarEmojis(false);
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
            <input className="input" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} placeholder="Nombre" />
            <input className="input" value={nueva.url} onChange={(e) => setNueva({ ...nueva, url: e.target.value })} placeholder="URL de YouTube" />
            <input
              className="input"
              value={nueva.categoria}
              list="cats-datalist"
              onChange={(e) => setNueva({ ...nueva, categoria: e.target.value })}
              placeholder="Categoría (opcional)"
            />
            <datalist id="cats-datalist">
              {categoriasExistentes.map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
            <div className="fila">
              <button className="boton boton-primario" onClick={guardar}>{editando ? "💾 Guardar cambios" : "💾 Guardar"}</button>
              <button className="boton" onClick={cancelarForm}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {(sonando || cargandoId === "detener") && (
        <div className="pies">
          {cargandoId === "detener" ? (
            <span className="ok"><span className="spinner spinner-pequeno" /> Deteniendo…</span>
          ) : (
            <>
              <span className="ok pies-sonando">▶ {sonando?.nombre}</span>
              <div className="timeline" title={durMs ? `${formatearTiempo(posMs)} de ${formatearTiempo(durMs)}` : "Midiendo duración…"}>
                <div className="timeline-barra">
                  <div className="timeline-lleno" style={{ width: `${progresoPct}%` }} />
                </div>
                <span className="timeline-tiempo">{durMs > 0 ? `${formatearTiempo(posMs)} / ${formatearTiempo(durMs)}` : formatearTiempo(posMs)}</span>
              </div>
              <button className="boton boton-parar" onClick={parar} disabled={cargandoId !== null}>⏹</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}