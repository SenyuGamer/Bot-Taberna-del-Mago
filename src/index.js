import { Client, GatewayIntentBits, MessageFlags } from "discord.js";
import { estrellitas, estrellitasNegras } from "./commands/estrellitas.js";
import { inspiracion } from "./commands/inspiracion.js";
import { dm } from "./commands/dm.js";
import { registros } from "./commands/registros.js";
import { sincronizar } from "./commands/sincronizar.js";
import { hora } from "./commands/hora.js";
import { syncmusic } from "./commands/syncmusic.js";
import { musica } from "./commands/musica.js";
import { testmusic } from "./commands/testmusic.js";
import { embedError } from "./utils.js";
import { iniciarTwitch } from "./twitch.js";
import { iniciarPuenteDjinni } from "./djinniBridge.js";
import { programarSalidaSiVacio } from "./voice/sessionManager.js";

const token = process.env.DISCORD_TOKEN;
if (!token || token === "pega_aqui_tu_token") {
  console.error("❌ Falta DISCORD_TOKEN en el archivo .env (pega el token real de tu bot).");
  process.exit(1);
}

export const comandos = new Map(
  [estrellitas, estrellitasNegras, inspiracion, dm, registros, sincronizar, hora, syncmusic, musica, testmusic].map((c) => [c.data.name, c])
);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once("clientReady", () => {
  console.log(`🍺 La Taberna del Mago abre sus puertas: ${client.user.tag} en línea.`);
  console.log(`📖 Comandos disponibles: ${[...comandos.keys()].map((n) => `/${n}`).join(", ")}`);
  iniciarTwitch(client);
  iniciarPuenteDjinni(client);
});

// Si el canal de voz se queda sin humanos, el bot se retira solo a los 5 min.
client.on("voiceStateUpdate", (oldState, newState) => {
  console.log("🎤 Discord.js voiceStateUpdate:", { guild: newState.guild?.id, channel: newState.channelId, session: newState.sessionId });
  for (const estado of [oldState, newState]) {
    if (estado?.guild) programarSalidaSiVacio(estado.guild, client);
  }
});

// Debug de eventos crudos de voz del gateway
client.ws.on("VOICE_SERVER_UPDATE", (data) => {
  console.log("🎤 Discord.js raw VOICE_SERVER_UPDATE:", JSON.stringify(data));
});
client.ws.on("VOICE_STATE_UPDATE", (data) => {
  console.log("🎤 Discord.js raw VOICE_STATE_UPDATE:", JSON.stringify(data));
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({
      embeds: [embedError("Los comandos de la taberna solo funcionan dentro de un servidor.")],
      flags: MessageFlags.Ephemeral,
    });
  }

  const comando = comandos.get(interaction.commandName);
  if (!comando) return;

  try {
    await comando.execute(interaction);
  } catch (error) {
    console.error(`Error ejecutando /${interaction.commandName}:`, error);
    const respuesta = {
      embeds: [embedError("El tabernero tropezó con un barril. Algo salió mal, inténtalo de nuevo.")],
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(respuesta).catch(() => {});
    } else {
      await interaction.reply(respuesta).catch(() => {});
    }
  }
});

try {
  await client.login(token);
} catch (error) {
  console.error("❌ No se pudo iniciar sesión. Revisa que DISCORD_TOKEN sea válido.", error.message);
  process.exit(1);
}
