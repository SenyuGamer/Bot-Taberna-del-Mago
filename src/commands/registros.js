import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { getConfig, setLogChannel } from "../db.js";
import { TEMA, embed, embedError, esAdmin, enviarRegistro } from "../utils.js";

const COLOR = TEMA.color.registro;

export const registros = {
  data: new SlashCommandBuilder()
    .setName("registros")
    .setDescription("Configura el canal de registros de la taberna (solo admins)")
    .addSubcommand((sub) =>
      sub
        .setName("establecer")
        .setDescription("Establece el canal donde se enviarán los registros")
        .addChannelOption((opt) =>
          opt
            .setName("canal")
            .setDescription("Canal de texto para los registros")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("quitar").setDescription("Desactiva el canal de registros")
    )
    .addSubcommand((sub) =>
      sub.setName("ver").setDescription("Muestra el canal de registros actual")
    ),

  async execute(interaction) {
    if (!esAdmin(interaction)) {
      return interaction.reply({
        embeds: [embedError("Solo un administrador puede configurar el canal de registros.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === "establecer") {
      const canal = interaction.options.getChannel("canal");
      setLogChannel(guildId, canal.id);
      await interaction.reply({
        embeds: [embed(COLOR, `📜 Los registros de la taberna se enviarán a ${canal}.`)],
      });
      await enviarRegistro(
        interaction.guild,
        embed(COLOR, `**${interaction.user.displayName}** estableció este canal como canal de registros. 🍺`, "📜 Registro de configuración")
      );
    }

    if (sub === "quitar") {
      const actual = getConfig(guildId).log_channel_id;
      if (!actual) {
        return interaction.reply({
          embeds: [embedError("No hay ningún canal de registros configurado.")],
          flags: MessageFlags.Ephemeral,
        });
      }
      setLogChannel(guildId, null);
      await interaction.reply({
        embeds: [embed(COLOR, "📜 El canal de registros ha sido desactivado.")],
      });
      await enviarRegistro(
        interaction.guild,
        embed(COLOR, `**${interaction.user.displayName}** desactivó el canal de registros.`, "📜 Registro de configuración")
      );
    }

    if (sub === "ver") {
      const actual = getConfig(guildId).log_channel_id;
      const texto = actual
        ? `📜 Los registros se envían a <#${actual}>.`
        : "📜 No hay canal de registros configurado. Usa `/registros establecer` para activarlo.";
      return interaction.reply({ embeds: [embed(COLOR, texto)], flags: MessageFlags.Ephemeral });
    }
  },
};
