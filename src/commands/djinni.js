import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { generarCodigoVinculacion } from "../djinniBridge.js";
import { listarCancionesMenu } from "../db.js";
import { TEMA, embed, embedError, esDMoAdmin } from "../utils.js";

const COLOR = 0x1db954; // verde música
const EMOJI = "🧞";

export const djinni = {
  data: new SlashCommandBuilder()
    .setName("djinni")
    .setDescription("Menú musical del DM (página dentro de Owlbear que reproduce en Discord)")
    .addSubcommand((sub) =>
      sub
        .setName("vincular")
        .setDescription("Genera un código para vincular el panel del menú a este servidor")
    )
    .addSubcommand((sub) =>
      sub.setName("menu").setDescription("Muestra las canciones guardadas en el menú")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === "menu") {
      const canciones = listarCancionesMenu();
      if (canciones.length === 0) {
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} El menú todavía está vacío. Añade canciones desde el panel (Oyente → extensión DJINNI) con el botón **Añadir**.\n\n*O permite que el DM guarde canciones ahí y se reproduzcan aquí en Discord.*`)],
        });
      }
      const lineas = canciones.map((c) => `${c.icono || "🎵"} **${c.nombre}**${c.loop ? " 🔁" : ""} — <${c.url}>`);
      return interaction.reply({
        embeds: [embed(COLOR, lineas.join("\n"), `${EMOJI} Canciones del menú`)],
      });
    }

    if (!esDMoAdmin(interaction)) {
      return interaction.reply({
        embeds: [embedError("Solo el DM o un administrador puede vincular el menú musical.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const codigo = generarCodigoVinculacion(interaction.guildId);
    return interaction.reply({
      embeds: [
        embed(
          COLOR,
          `🧞 **Código de verificación**\n\n` +
          `**\`${codigo}\`** *(válido 10 minutos, uso único)*\n\n` +
          `Ábrelo en el panel DJINNI dentro de Owlbear y pega el código para vincular la página a **${interaction.guild.name}**. ` +
          `Cuando pulses una canción ahí, sonará en el canal que hayas conectado con \`/musica unir\`.`,
          `${EMOJI} Vincular panel DJINNI`
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};