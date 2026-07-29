import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getInspirations, addInspirations } from "../db.js";
import { TEMA, embed, embedError, esDM, esDMoAdmin, enviarRegistro } from "../utils.js";

const { inspiracion: EMOJI, } = TEMA.emoji;
const COLOR = TEMA.color.inspiracion;

export const inspiracion = {
  data: new SlashCommandBuilder()
    .setName("inspiracion")
    .setDescription("Gestiona las inspiraciones heroicas")
    .addSubcommand((sub) =>
      sub
        .setName("sumar")
        .setDescription("Súmate inspiraciones heroicas a ti mismo (queda en el registro)")
        .addIntegerOption((opt) =>
          opt.setName("cantidad").setDescription("Cantidad a sumar (por defecto 1)").setMinValue(1)
        )
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Sumar a otro jugador (solo DM/admins)")
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("restar")
        .setDescription("Resta inspiraciones heroicas (solo el DM)")
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Jugador al que se le resta").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("cantidad").setDescription("Cantidad a restar (por defecto 1)").setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("ver")
        .setDescription("Consulta las inspiraciones heroicas de un jugador")
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Jugador a consultar (por defecto tú)")
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === "sumar") {
      const jugador = interaction.options.getUser("jugador") ?? interaction.user;
      const aSiMismo = jugador.id === interaction.user.id;

      if (!aSiMismo && !esDMoAdmin(interaction)) {
        return interaction.reply({
          embeds: [embedError("Solo el DM o un administrador puede sumar inspiraciones a otros jugadores.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      const cantidad = interaction.options.getInteger("cantidad") ?? 1;
      const nuevoTotal = addInspirations(guildId, jugador.id, cantidad);

      const texto = aSiMismo
        ? `${EMOJI} **${interaction.user.displayName}** anota **${cantidad}** inspiración(es) heroica(s) en su libreta.\nAhora tiene **${nuevoTotal}** ${EMOJI}.`
        : `${EMOJI} **${jugador.displayName}** recibe **${cantidad}** inspiración(es) heroica(s).\nAhora tiene **${nuevoTotal}** ${EMOJI}.`;
      await interaction.reply({ embeds: [embed(COLOR, texto)] });

      await enviarRegistro(
        interaction.guild,
        embed(
          COLOR,
          `**${interaction.user.displayName}** sumó **${cantidad}** inspiración(es) heroica(s) a **${jugador.displayName}**.\nTotal actual: **${nuevoTotal}** ${EMOJI}`,
          `${EMOJI} Registro de inspiraciones`
        )
      );
    }

    if (sub === "restar") {
      if (!esDM(interaction)) {
        return interaction.reply({
          embeds: [embedError("Solo el DM puede restar inspiraciones heroicas. Si aún no hay DM, un administrador puede asignarlo con `/dm asignar`.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      const jugador = interaction.options.getUser("jugador");
      const cantidad = interaction.options.getInteger("cantidad") ?? 1;
      const nuevoTotal = addInspirations(guildId, jugador.id, -cantidad);

      if (nuevoTotal === null) {
        return interaction.reply({
          embeds: [embedError(`${jugador} no tiene suficientes inspiraciones (tiene ${getInspirations(guildId, jugador.id)}).`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.reply({
        embeds: [embed(COLOR, `${EMOJI} El DM gasta **${cantidad}** inspiración(es) heroica(s) de **${jugador.displayName}**.\nLe quedan **${nuevoTotal}** ${EMOJI}.`)],
      });

      await enviarRegistro(
        interaction.guild,
        embed(
          COLOR,
          `**${interaction.user.displayName}** (DM) restó **${cantidad}** inspiración(es) heroica(s) a **${jugador.displayName}**.\nTotal actual: **${nuevoTotal}** ${EMOJI}`,
          `${EMOJI} Registro de inspiraciones`
        )
      );
    }

    if (sub === "ver") {
      const jugador = interaction.options.getUser("jugador") ?? interaction.user;
      const total = getInspirations(guildId, jugador.id);
      return interaction.reply({
        embeds: [embed(COLOR, `${EMOJI} **${jugador.displayName}** tiene **${total}** inspiración(es) heroica(s).`)],
      });
    }
  },
};
