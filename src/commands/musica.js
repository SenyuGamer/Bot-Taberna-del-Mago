import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getSesion, agregarFuente, quitarFuentesManuales } from "../voice/sessionManager.js";
import { TEMA, embed, embedError, esDMoAdmin } from "../utils.js";

const COLOR = 0x1db954;
const EMOJI = "🎶";

export const musica = {
  data: new SlashCommandBuilder()
    .setName("musica")
    .setDescription("Pon música directamente desde Discord (sin Owlbear)")
    .addSubcommand((sub) =>
      sub
        .setName("url")
        .setDescription("Reproduce un enlace de YouTube (o cualquier URL que entienda yt-dlp)")
        .addStringOption((opt) =>
          opt.setName("enlace").setDescription("Enlace de YouTube del tema").setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt.setName("loop").setDescription("Repetir en bucle (ambiente)")
        )
        .addIntegerOption((opt) =>
          opt.setName("volumen").setDescription("Volumen 1-100 (por defecto 80)").setMinValue(1).setMaxValue(100)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("paro")
        .setDescription("Quita tus temas manuales (DM/admins: también los de todos)")
        .addBooleanOption((opt) =>
          opt.setName("todos").setDescription("Quitar los temas manuales de TODOS (solo DM/admins)")
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const sesion = getSesion(interaction.guildId);

    if (!sesion) {
      return interaction.reply({
        embeds: [embedError("El bot no está en un canal de voz. Usa primero `/syncmusic unir`.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === "paro") {
      const todos = interaction.options.getBoolean("todos") ?? false;
      if (todos && !esDMoAdmin(interaction)) {
        return interaction.reply({
          embeds: [embedError("Solo el DM o un administrador puede parar los temas de todos.")],
          flags: MessageFlags.Ephemeral,
        });
      }
      const quitadas = quitarFuentesManuales(interaction.guildId, todos ? {} : { soloDe: interaction.user.id });
      return interaction.reply({
        embeds: [embed(COLOR, quitadas > 0
          ? `${EMOJI} Quité **${quitadas}** tema(s) manual(es)${todos ? " (de todos)" : ""}.`
          : `${EMOJI} No había temas manuales sonando${todos ? "" : " tuyos"}.`)],
      });
    }

    // -------- url --------
    const url = interaction.options.getString("enlace");
    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({
        embeds: [embedError("Eso no parece un enlace válido. Pásame una URL de YouTube, por ejemplo.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Regla de convivencia: hay que estar en la llamada (o ser DM/admin)
    const vozMiembro = interaction.member?.voice?.channelId;
    if (vozMiembro !== sesion.canalId && !esDMoAdmin(interaction)) {
      return interaction.reply({
        embeds: [embedError(`Tienes que estar en el canal de voz <#${sesion.canalId}> para pinchar música (o ser DM/admin).`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const loop = interaction.options.getBoolean("loop") ?? false;
    const volumen = (interaction.options.getInteger("volumen") ?? 80) / 100;
    const id = `manual:${interaction.user.id}:${Date.now()}`;

    await interaction.deferReply();
    const creado = agregarFuente(interaction.guildId, {
      id,
      url,
      volumen,
      loop,
      tipo: "manual",
      userId: interaction.user.id,
    });
    if (!creado) {
      return interaction.editReply({ embeds: [embedError("La sesión de música desapareció. Usa `/syncmusic unir` de nuevo.")] });
    }

    try {
      await creado.promesa;
      return interaction.editReply({
        embeds: [
          embed(
            COLOR,
            `${EMOJI} Sonando: <${url}>${loop ? " 🔁" : ""} · volumen ${Math.round(volumen * 100)}%\n*Añadido por ${interaction.user.displayName}. Para quitarlo: \`/musica paro\`.*`,
            `${EMOJI} Tema pinchado`
          ),
        ],
      });
    } catch (error) {
      return interaction.editReply({ embeds: [embedError(`No pude reproducir ese enlace: ${error.message}`)] });
    }
  },
};
