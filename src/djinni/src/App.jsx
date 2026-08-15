import "./App.css";
import React, { useState, useEffect, useCallback } from "react";
import OBR from "@owlbear-rodeo/sdk";

// Panel "DJINNI · Taberna del Mago" para el DM.
// - Solo se muestra al GM (la extensión, vista del DM).
// - Se vincula a un servidor de Discord con un código (/djinni vincular).
// - Muestra el menú global de canciones como tarjetas horizontales (icono encima,
//   nombre debajo), igual que la app original de DJINNI.
// - Clic en una tarjeta → suena SOLO en el bot de Discord (nunca aquí).
// - Feedback: mientras la canción carga se muestra un spinner en la tarjeta.

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
  const [token, setToken] = useState(() => localStorage.getItem("djinni_token") || "");
  const [codigo, setCodigo] = useState("");
  const [canciones, setCanciones] = useState([]);
  const [sonando, setSonando] = useState(null); // { id, nombre }
  const [guildName, setGuildName] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const [vinculando, setVinculando] = useState(false);
  const [cargandoId, setCargandoId] = useState(null); // id de la canción en proceso
  const [mostrarForm, setMostrarForm] = useState(false);
  const [nueva, setNueva] = useState({ nombre: "", icono: "", url: "", loop: false });

  const recargar = useCallback(async () => {
    if (!token) return;
    const f = api(token);
    try {
      const [menu, est] = await Promise.all([f("/api/djinni/menu"), f("/api/djinni/estado")]);
      setCanciones(menu.canciones ?? []);
      setSonando(est.sonando ? { id: est.cancionId, nombre: est.nombre } : null);
    } catch (e) {
      if (/vinculado/i.test(e.message)) {
        localStorage.removeItem("djinni_token");
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
      if (token) recargar();
    });
  }, [token, recargar]);

  async function vincular() {
    setVinculando(true);
    setError("");
    try {
      const datos = await api()("/api/djinni/vincula", {
        method: "POST",
        body: JSON.stringify({ codigo: codigo.trim() }),
      });
      localStorage.setItem("djinni_token", datos.token);
      setToken(datos.token);
      setGuildName(datos.guildName ?? "");
      setEstado(ESTADOS.LISTO);
      await recargar();
    } catch (e) {
      setError(e.message);
    } finally {
      setVinculando(false);
    }
  }

  function desvincular() {
    localStorage.removeItem("djinni_token");
    setToken("");
    setEstado(ESTADOS.NO_VINCULADO);
  }

  async function reproducir(id, nombre) {
    setCargandoId(id);
    setError("");
    setMensaje("");
    try {
      await api(token)("/api/djinni/play", { method: "POST", body: JSON.stringify({ id }) });
      setSonando({ id, nombre });
      setMensaje(`✓ Sonando: ${nombre}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setCargandoId(null);
    }
  }

  async function parar() {
    setError("");
    setMensaje("");
    setCargandoId("detener");
    try {
      await api(token)("/api/djinni/stop", { method: "POST", body: JSON.stringify({}) });
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
      await api(token)("/api/djinni/menu", { method: "POST", body: JSON.stringify(nueva) });
      setNueva({ nombre: "", icono: "", url: "", loop: false });
      setMostrarForm(false);
      await recargar();
    } catch (e) {
      setError(e.message);
    }
  }

  async function borrar(id) {
    setError("");
    setMensaje("");
    await api(token)(`/api/djinni/menu/${id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    await recargar();
    if (sonando?.id === id) setSonando(null);
  }

  const esSonando = (c) => sonando?.id === c.id;

  if (estado === ESTADOS.CARGANDO) {
    return <div className="app-row"><span className="aviso">Cargando…</span></div>;
  }

  if (estado === ESTADOS.NO_GM) {
    return (
      <div className="app">
        <div className="app-row">
          <span className="titulo">🧞 DJINNI</span>
          <span className="aviso">Solo el <b>DM</b> ve el menú musical.</span>
        </div>
      </div>
    );
  }

  if (estado === ESTADOS.NO_VINCULADO) {
    return (
      <div className="app">
        <span className="titulo">🧞 DJINNI · Taberna del Mago</span>
        <p className="aviso">Pega el código de verificación de <code>/djinni vincular</code> para enlazar este panel con el bot de Discord.</p>
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
        <button className="boton boton-chico" onClick={desvincular} title="Desvincular este panel">⏻</button>
      </div>

      <div className="mensajes">
        {mensaje && <span className="ok">{mensaje}</span>}
        {error && <span className="error">❌ {error}</span>}
      </div>

      <div className="escenario">
        {canciones.map((c) => (
          <div key={c.id} className={`escena ${cargandoId === c.id ? "escena-cargando" : ""} ${esSonando(c) ? "escena-sonando" : ""}`}>
            <button
              className="escena-btn"
              onClick={() => reproducir(c.id, c.nombre)}
              disabled={cargandoId !== null && cargandoId !== c.id}
              title={`${c.url}${c.loop ? " 🔁" : ""}`}
            >
              {cargandoId === c.id ? (
                <span className="spinner" />
              ) : (
                <span className="icono">{c.icono || "🎵"}</span>
              )}
              <span className="escena-fila">
                <span className="nombre">{c.nombre}</span>
                <span className="badge">{c.loop ? "🔁" : ""}{esSonando(c) ? "▶" : ""}</span>
              </span>
            </button>
            <button className="basura" onClick={() => borrar(c.id)} title="Quitar del menú">🗑</button>
          </div>
        ))}

        {mostrarForm ? (
          <div className="form">
            <input className="input" value={nueva.icono} onChange={(e) => setNueva({ ...nueva, icono: e.target.value })} placeholder="Icono (emoji)" maxLength={8} />
            <input className="input" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} placeholder="Nombre" />
            <input className="input" value={nueva.url} onChange={(e) => setNueva({ ...nueva, url: e.target.value })} placeholder="URL de YouTube" />
            <label className="aviso">
              <input type="checkbox" checked={nueva.loop} onChange={(e) => setNueva({ ...nueva, loop: e.target.checked })} /> Bucle 🔁
            </label>
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