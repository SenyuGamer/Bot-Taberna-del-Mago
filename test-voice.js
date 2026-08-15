import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { Mixer } from "./src/voice/mixer.js";
import { crearPipeline } from "./src/voice/pipeline.js";

// Uso: node --env-file=.env --disable-warning=ExperimentalWarning test-voice.js [url] [segundos]
const URL = process.argv[2] || "https://www.youtube.com/watch?v=30bsbpHdJFo";
const SEGUNDOS = Number(process.argv[3] || 25);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once("clientReady", async () => {
  console.log(`✅ Logeado como ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error("❌ El bot no está en ningún servidor.");
    process.exit(1);
  }
  const canal = guild.channels.cache.find((c) => c.isVoiceBased());
  if (!canal) {
    console.error(`❌ No hay canales de voz en ${guild.name}.`);
    process.exit(1);
  }
  console.log(`🎤 Uniendo a "${canal.name}" (${canal.id}) en "${guild.name}"...`);

  const connection = joinVoiceChannel({
    channelId: canal.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    daveEncryption: false,
  });

  connection.on("stateChange", (v, n) => {
    console.log(`  voz: ${v.status} → ${n.status}`);
  });
  connection.on("error", (e) => console.error("  ❌ error voz:", e.message));
  connection.on("debug", (m) => console.log("  debug:", m));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log("✅ Conexión READY.");
  } catch (error) {
    console.error("❌ No llegó a Ready:", error.message);
    connection.destroy();
    process.exit(1);
  }

  const player = createAudioPlayer();
  const mixer = new Mixer();
  const recurso = createAudioResource(mixer.salida, { inputType: StreamType.Raw });
  player.play(recurso);
  connection.subscribe(player);

  mixer.agregarFuente("test", 1);
  console.log(`🎵 Reproduciendo: ${URL}`);
  const pipeline = crearPipeline({
    url: URL,
    onDatos: (bytes) => mixer.empujar("test", bytes),
    onError: (e) => console.error("  ❌ pipeline:", e.message),
    onFin: () => console.log("  fin de la fuente"),
  });

  try {
    await pipeline.esperarPrimerAudio(25_000);
    console.log("✅ PRIMER AUDIO recibido (la URL suena).");
  } catch (error) {
    console.error(`❌ Sin audio: ${error.message}`);
  }

  setTimeout(() => {
    console.log("👋 Desconectando...");
    connection.destroy();
    process.exit(0);
  }, SEGUNDOS * 1000);
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error("❌ Login falló:", e.message);
  process.exit(1);
});
