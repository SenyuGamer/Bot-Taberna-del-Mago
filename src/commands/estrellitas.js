import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { getStars, addStars, topStars } from "../db.js";
import { TEMA, embed, embedError, esDMoAdmin, enviarRegistro } from "../utils.js";

/**
 * Fábrica de comandos de estrellitas. Genera /estrellitas (normales)
 * y /estrellitas-negras con la misma lógica.
 */
export function crearComandoEstrellitas({ tipo, nombre, emoji, color, sustantivo }) {
  const data = new SlashCommandBuilder()
    .setName(nombre)
    .setDescription(`Gestiona las ${sustantivo} de los jugadores`)
    .addSubcommand((sub) =>
      sub
        .setName("agregar")
        .setDescription(`Agrega ${sustantivo} a un jugador (solo DM/admins)`)
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Jugador que recibe las estrellitas").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("cantidad").setDescription("Cantidad a agregar (por defecto 1)").setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("quitar")
        .setDescription(`Quita ${sustantivo} a un jugador (solo DM/admins)`)
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Jugador al que se le quitan").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("cantidad").setDescription("Cantidad a quitar (por defecto 1)").setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("ver")
        .setDescription(`Consulta las ${sustantivo} de un jugador`)
        .addUserOption((opt) =>
          opt.setName("jugador").setDescription("Jugador a consultar (por defecto tú)")
        )
    )
    .addSubcommand((sub) =>
      sub.setName("top").setDescription(`Tabla de clasificación de ${sustantivo}`)
    );

  async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === "agregar" || sub === "quitar") {
      if (!esDMoAdmin(interaction)) {
        return interaction.reply({
          embeds: [embedError(`Solo el DM ${emoji} o un administrador puede modificar las ${sustantivo}.`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      const jugador = interaction.options.getUser("jugador");
      const cantidad = interaction.options.getInteger("cantidad") ?? 1;
      const delta = sub === "agregar" ? cantidad : -cantidad;
      const nuevoTotal = addStars(guildId, jugador.id, tipo, delta);

      if (nuevoTotal === null) {
        return interaction.reply({
          embeds: [embedError(`${jugador} no tiene suficientes ${sustantivo} (tiene ${getStars(guildId, jugador.id, tipo)}).`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      const accion = sub === "agregar" ? "recibe" : "pierde";
      const embedRespuesta = embed(
        color,
        `${emoji} **${jugador.displayName}** ${accion} **${cantidad}** ${sustantivo}.\nAhora tiene **${nuevoTotal}** ${emoji} en el libro de la taberna.`
      );
      await interaction.reply({ embeds: [embedRespuesta] });

      await enviarRegistro(
        interaction.guild,
        embed(
          color,
          `**${interaction.user.displayName}** ${sub === "agregar" ? "agregó" : "quitó"} **${cantidad}** ${sustantivo} a **${jugador.displayName}**.\nTotal actual: **${nuevoTotal}** ${emoji}`,
          `${emoji} Registro de ${sustantivo}`
        )
      );
    }

    if (sub === "ver") {
      const jugador = interaction.options.getUser("jugador") ?? interaction.user;
      const total = getStars(guildId, jugador.id, tipo);
      return interaction.reply({
        embeds: [embed(color, `${emoji} **${jugador.displayName}** tiene **${total}** ${sustantivo}.`)],
      });
    }

    if (sub === "top") {
      const filas = topStars(guildId, tipo);
      if (filas.length === 0) {
        return interaction.reply({
          embeds: [embed(color, `Aún nadie tiene ${sustantivo} ${emoji}. ¡El tabernero espera buenas acciones!`)],
        });
      }
      const medallas = ["🥇", "🥈", "🥉"];
      const lineas = filas.map(
        (fila, i) => `${medallas[i] ?? `**${i + 1}.**`} <@${fila.user_id}> — **${fila.cantidad}** ${emoji}`
      );
      return interaction.reply({
        embeds: [embed(color, lineas.join("\n"), `${emoji} Salón de la fama: ${sustantivo}`)],
      });
    }
  }

  return { data, execute };
}

export const estrellitas = crearComandoEstrellitas({
  tipo: "normal",
  nombre: "estrellitas",
  emoji: TEMA.emoji.estrella,
  color: TEMA.color.estrella,
  sustantivo: "estrellitas",
});

export const estrellitasNegras = crearComandoEstrellitas({
  tipo: "negra",
  nombre: "estrellitas-negras",
  emoji: TEMA.emoji.estrellaNegra,
  color: TEMA.color.estrellaNegra,
  sustantivo: "estrellitas negras",
});
