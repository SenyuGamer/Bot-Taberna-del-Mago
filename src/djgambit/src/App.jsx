import "./App.css";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import OBR from "@owlbear-rodeo/sdk";

// Panel "DJGAMBIT · Taberna del Mago" para el DM.
// - Solo se muestra al GM (la extensión, vista del DM).
// - Se vincula a un servidor de Discord con un código (/musica vincular).
// - Muestra el menú global de canciones agrupado por categorías (tarjetas con
//   icono encima y nombre debajo, como en la app original de DJGAMBIT).
// - Clic en una tarjeta → suena SOLO en el bot de Discord (nunca aquí).
// - Las canciones se guardan en caché automáticamente al añadirlas y se quitan
//   de la caché al borrarlas; se muestra "guardando en caché…" mientras se baja.
// - 🔁 por canción: repetir esa canción. ↻ por categoría: suena toda la categoría
//   en bucle (lista de reproducción).

const API = ""; // relativo: el panel se sirve desde el mismo túnel que el bridge

const ESTADOS = {
  CARGANDO: "cargando",
  NO_GM: "no-gm",
  NO_VINCULADO: "no-vinculado",
  LISTO: "listo",
};

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

export default function App() {
  const [estado, setEstado] = useState(ESTADOS.CARGANDO);
  const [token, setToken] = useState(() => localStorage.getItem("djgambit_token") || "");
  const [codigo, setCodigo] = useState("");
  const [canciones, setCanciones] = useState([]);
  const [sonando, setSonando] = useState(null); // { id, nombre }
  const [guildName, setGuildName] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const [vinculando, setVinculando] = useState(false);
  const [cargandoId, setCargandoId] = useState(null); // id de la canción en proceso
  const [mostrarForm, setMostrarForm] = useState(false);
  const [nueva, setNueva] = useState({ nombre: "", icono: "", url: "", categoria: "" });
  const [crossfade, setCrossfade] = useState(() => localStorage.getItem("djgambit_crossfade") === "1");
  const [loops, setLoops] = useState(() => JSON.parse(localStorage.getItem("djgambit_loops") || "{}")); // id -> bool
  const [cats, setCats] = useState(() => JSON.parse(localStorage.getItem("djgambit_cats") || "{}")); // categoria -> bool (playlist)

  const ultimoJson = useRef("");

  const sincronizar = useCallback(async () => {
    if (!token) return;
    const f = api(token);
    try {
      const [menu, est] = await Promise.all([f("/api/djgambit/menu"), f("/api/djgambit/estado")]);
      const canc = menu.canciones ?? [];
      const sig = JSON.stringify({ canc, sonando: est.sonando ? { id: est.cancionId, nombre: est.nombre } : null });
      if (sig !== ultimoJson.current) {
        ultimoJson.current = sig;
        setCanciones(canc);
        setSonando(est.sonando ? { id: est.cancionId, nombre: est.nombre } : null);
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
      OBR.action.setHeight(420);
      setEstado(token ? ESTADOS.LISTO : ESTADOS.NO_VINCULADO);
      if (token) sincronizar();
    });
  }, [token, sincronizar]);

  // Refresco periódico leve: actualiza el estado de caché (guardando → hecho) y sonando.
  useEffect(() => {
    if (estado !== ESTADOS.LISTO || !token) return;
    const id = setInterval(() => sincronizar(), 4000);
    return () => clearInterval(id);
  }, [estado, token, sincronizar]);

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
      const body = { id, crossfade };
      if (catLoop) {
        body.loopCategoria = true; // suena toda la categoría en bucle desde esta canción
      } else {
        body.loop = !!loops[id]; // repetir esta canción
      }
      await api(token)("/api/djgambit/play", { method: "POST", body: JSON.stringify(body) });
      setSonando({ id, nombre });
      setMensaje(`✓ Sonando: ${nombre}${catLoop ? ` · ${categoria} ↻` : loops[id] ? " · 🔁" : ""}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCargandoId(null);
    }
  }

  function alternarCrossfade() {
    setCrossfade((v) => {
      localStorage.setItem("djgambit_crossfade", v ? "0" : "1");
      return !v;
    });
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

  async function parar() {
    setError("");
    setMensaje("");
    setCargandoId("detener");
    try {
      await api(token)("/api/djgambit/stop", { method: "POST", body: JSON.stringify({}) });
      setSonando(null);
      setMensaje("✓ Reproducción detenida");
    } catch (e) {
      setError(e.message);
    } finally {
      setCargandoId(null);
    }
  }

  async function guardar() {
    setError("");
    setMensaje("");
    if (!nueva.nombre.trim() || !/^https?:\/\//i.test(nueva.url)) {
      setError("Escribe un nombre y una URL de YouTube válida.");
      return;
    }
    try {
      await api(token)("/api/djgambit/menu", { method: "POST", body: JSON.stringify(nueva) });
      setNueva({ nombre: "", icono: "", url: "", categoria: "" });
      setMostrarForm(false);
      await sincronizar();
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

  // Agrupar canciones por categoría, conservando el orden de inserción.
  const grupos = useMemo(() => {
    const orden = [];
    const mapa = new Map();
    for (const c of canciones) {
      const cat = c.categoria || "Sin categoría";
      if (!mapa.has(cat)) {
        mapa.set(cat, []);
        orden.push(cat);
      }
      mapa.get(cat).push(c);
    }
    return orden.map((cat) => ({ cat, items: mapa.get(cat) }));
  }, [canciones]);

  const cacheEnCurso = canciones.filter((c) => c.cacheando);

  const esSonando = (c) => sonando?.id === c.id;

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
          <button className="boton boton-chico" onClick={cachearTodas} title="Descargar todas las canciones a caché" disabled={cargandoId !== null}>⬇</button>
          <label className="toggle" title="Fundir la canción anterior en la nueva al cambiar">
            <input type="checkbox" checked={crossfade} onChange={alternarCrossfade} /> 🔀
          </label>
          <button className="boton boton-chico" onClick={desvincular} title="Desvincular este panel">⏻</button>
        </div>
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
              <div className="cat-cab">
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
                    <div key={c.id} className={`escena ${cargandoId === c.id ? "escena-cargando" : ""} ${esSonando(c) ? "escena-sonando" : ""}`}>
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
                      <button className="basura" onClick={() => borrar(c.id)} title="Quitar del menú">🗑</button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {mostrarForm ? (
          <div className="form">
            <input className="input" value={nueva.icono} onChange={(e) => setNueva({ ...nueva, icono: e.target.value })} placeholder="Icono (emoji)" maxLength={8} />
            <input className="input" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} placeholder="Nombre" />
            <input className="input" value={nueva.url} onChange={(e) => setNueva({ ...nueva, url: e.target.value })} placeholder="URL de YouTube" />
            <input className="input" value={nueva.categoria} onChange={(e) => setNueva({ ...nueva, categoria: e.target.value })} placeholder="Categoría (opcional)" />
            <div className="fila">
              <button className="boton boton-primario" onClick={guardar}>💾 Guardar</button>
              <button className="boton" onClick={() => setMostrarForm(false)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <button className="boton boton-nueva" onClick={() => setMostrarForm(true)} disabled={cargandoId !== null}>
            ＋
          </button>
        )}
      </div>

      {(sonando || cargandoId === "detener") && (
        <div className="pies">
          {cargandoId === "detener" ? (
            <span className="ok"><span className="spinner spinner-pequeno" /> Deteniendo…</span>
          ) : (
            <>
              <span className="ok">▶ {sonando?.nombre}</span>
              <button className="boton boton-parar" onClick={parar} disabled={cargandoId !== null}>⏹</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}