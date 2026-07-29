import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getConfig, setDm } from "../db.js";
import { TEMA, embed, embedError, esAdmin, enviarRegistro } from "../utils.js";

const EMOJI = TEMA.emoji.dm;
const COLOR = TEMA.color.dm;

export const dm = {
  data: new SlashCommandBuilder()
    .setName("dm")
    .setDescription("Gestiona el Dungeon Master de la taberna")
    .addSubcommand((sub) =>
      sub
        .setName("asignar")
        .setDescription("Asigna el DM del servidor (solo admins)")
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Usuario que será el DM").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("quitar").setDescription("Quita el DM actual (solo admins)")
    )
    .addSubcommand((sub) =>
      sub.setName("ver").setDescription("Muestra quién es el DM actual")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === "asignar") {
      if (!esAdmin(interaction)) {
        return interaction.reply({
          embeds: [embedError("Solo un administrador puede asignar al DM.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      const jugador = interaction.options.getUser("jugador");
      const anterior = getConfig(guildId).dm_id;
      setDm(guildId, jugador.id);

      const texto = anterior && anterior !== jugador.id
        ? `${EMOJI} El repentino giro del destino nombra a **${jugador.displayName}** como nuevo DM de la taberna (reemplaza a <@${anterior}>).`
        : `${EMOJI} **${jugador.displayName}** es ahora el DM de la taberna. ¡Que empiece la aventura!`;
      await interaction.reply({ embeds: [embed(COLOR, texto)] });

      await enviarRegistro(
        interaction.guild,
        embed(
          COLOR,
          `**${interaction.user.displayName}** asignó a **${jugador.displayName}** como DM.${anterior ? `\nDM anterior: <@${anterior}>` : ""}`,
          `${EMOJI} Registro de DM`
        )
      );
    }

    if (sub === "quitar") {
      if (!esAdmin(interaction)) {
        return interaction.reply({
          embeds: [embedError("Solo un administrador puede quitar al DM.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      const actual = getConfig(guildId).dm_id;
      if (!actual) {
        return interaction.reply({
          embeds: [embedError("No hay ningún DM asignado actualmente.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      setDm(guildId, null);
      await interaction.reply({
        embeds: [embed(COLOR, `${EMOJI} <@${actual}> ya no es el DM de la taberna.`)],
      });

      await enviarRegistro(
        interaction.guild,
        embed(COLOR, `**${interaction.user.displayName}** quitó a <@${actual}> como DM.`, `${EMOJI} Registro de DM`)
      );
    }

    if (sub === "ver") {
      const actual = getConfig(guildId).dm_id;
      const texto = actual
        ? `${EMOJI} El DM actual de la taberna es <@${actual}>.`
        : `${EMOJI} La taberna no tiene DM asignado. Un administrador puede asignarlo con \`/dm asignar\`.`;
      return interaction.reply({ embeds: [embed(COLOR, texto)] });
    }
  },
};
