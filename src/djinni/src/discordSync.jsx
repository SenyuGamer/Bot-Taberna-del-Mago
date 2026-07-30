// ============================================================================
//  SINCRONIZACIÓN CON DISCORD (parche "La Taberna del Mago")
//
//  Envía el estado de reproducción de Djinni al bot de Discord para que suene
//  en la llamada de voz. SOLO envía desde el navegador del GM (los jugadores
//  no empujan nada, evitando duplicados).
//
//  ANTES DEL BUILD (`npm run build`), configura estas dos constantes:
const BRIDGE_URL = "https://owltwitch.cobaltcatstudios.com"; // tu túnel (sin barra final)
const BRIDGE_SLUG = "PEGA_AQUI_TU_SLUG";                 // el DJINNI_SLUG del .env del bot
// ============================================================================

const ENDPOINT = `${BRIDGE_URL}/api/state/${BRIDGE_SLUG}`;
const DEBOUNCE_MS = 600;

let instalado = false;
let temporizador = null;
let esGM = null;

function comprobarEsGM() {
	if (esGM !== null) return Promise.resolve(esGM);
	return OBR.player.getRole()
		.then((rol) => { esGM = rol === "GM"; return esGM; })
		.catch(() => { esGM = false; return false; });
}

function construirPayload(state) {
	return {
		paused: state.paused ?? "playing",
		soundOutput: state.soundOutput ?? "global",
		streams: (state.currentlyStreaming ?? []).map((stream) => ({
			id: String(stream.id),
			name: stream.streamName ?? "",
			playing: !!stream.playing,
			streamMute: !!stream.streamMute,
			streamVolume: (stream.streamVolume ?? 100) / 100, // Djinni usa 0-100
			links: (stream.streamData ?? []).map((link) => ({
				name: link.name ?? "",
				link: link.link ?? "",
				playing: link.playing !== false,
				mute: !!link.mute,
				volume: (link.volume ?? 100) / 100, // Djinni usa 0-100
				loop: !!link.loop,
				loopMinSec: Number(link.loop1) || 0,
				loopMaxSec: Number(link.loop2) || 0,
			})),
		})),
	};
}

async function postear() {
	temporizador = null;
	if (!(await comprobarEsGM())) return; // solo el GM empuja al bot
	const payload = construirPayload(useMetadataStore.getState());
	try {
		const resp = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!resp.ok) {
			console.warn(`[DiscordSync] El bot respondió ${resp.status} (¿slug correcto? ¿bot encendido?)`);
		}
	} catch (error) {
		console.warn("[DiscordSync] No se pudo contactar con el bot de Discord:", error.message ?? error);
	}
}

function programarPost() {
	if (temporizador) clearTimeout(temporizador);
	temporizador = setTimeout(postear, DEBOUNCE_MS);
}

/** Instala la sincronización una vez (llamado desde index.jsx). */
export function instalarDiscordSync() {
	if (instalado) return;
	instalado = true;

	if (!OBR?.onReady) {
		console.warn("[DiscordSync] OBR no disponible (¿preview fuera de Owlbear?). Sincronización omitida.");
		return;
	}

	// Si OBR nunca queda listo (fuera de Owlbear), cancelamos en silencio a los 8 s
	let abortado = false;
	setTimeout(() => { if (esGM === null) { abortado = true; } }, 8000);

	OBR.onReady(async () => {
		if (abortado) return;
		await comprobarEsGM();
		console.log(`[DiscordSync] Activo${esGM ? " (enviando como GM)" : " (modo jugador: no envío)"} → ${BRIDGE_URL}`);
		// Estado inicial al conectar (por si ya había algo sonando)
		programarPost();
	});

	useMetadataStore.subscribe(() => {
		if (abortado) return;
		programarPost();
	});

	// Si el GM cierra la pestaña con música sonando, avisamos al bot para que se calle
	window.addEventListener("pagehide", () => {
		if (esGM) {
			try {
				const payload = { paused: "paused", soundOutput: "global", streams: [] };
				navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], { type: "text/plain" }));
			} catch { /* mejor esfuerzo */ }
		}
	});
}
