import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { getConfig } from "./db.js";

// ---------- Tema visual de La Taberna del Mago ----------

export const TEMA = {
  color: {
    estrella: 0xffc857,
    estrellaNegra: 0x2b2d31,
    inspiracion: 0x3498db,
    dm: 0x9b59b6,
    twitch: 0x9146ff,
    registro: 0x95a5a6,
    error: 0xe74c3c,
  },
  emoji: {
    estrella: "⭐",
    estrellaNegra: "⚫",
    inspiracion: "✨",
    dm: "🧙",
  },
  footer: "La Taberna del Mago",
};

export function embed(color, descripcion, titulo = null) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setDescription(descripcion)
    .setFooter({ text: TEMA.footer })
    .setTimestamp();
  if (titulo) e.setTitle(titulo);
  return e;
}

export function embedError(descripcion) {
  return embed(TEMA.color.error, `❌ ${descripcion}`);
}

// ---------- Permisos ----------

export function esAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

export function esDM(interaction) {
  const config = getConfig(interaction.guildId);
  return config.dm_id === interaction.user.id;
}

export function esDMoAdmin(interaction) {
  return esDM(interaction) || esAdmin(interaction);
}

// ---------- Mensajes de registro ----------

/** Envía un mensaje de registro al canal configurado del servidor (si hay). */
export async function enviarRegistro(guild, embedRegistro) {
  try {
    const config = getConfig(guild.id);
    if (!config.log_channel_id) return;
    const canal = await guild.channels.fetch(config.log_channel_id).catch(() => null);
    if (!canal?.isTextBased()) return;
    await canal.send({ embeds: [embedRegistro] });
  } catch (error) {
    console.error("No se pudo enviar el mensaje de registro:", error);
  }
}
