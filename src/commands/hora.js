import { SlashCommandBuilder } from "discord.js";
import { TEMA, embed } from "../utils.js";

const ZONA_TIJUANA = "America/Tijuana";

/**
 * Devuelve la fecha formateada en la zona de Tijuana.
 * Usa la base de datos IANA que Node trae incorporada: los cambios de
 * horario (verano/invierno, reglas de EE.UU. para Baja California) se
 * aplican solos según la fecha — no hay que programar nada a mano.
 */
export function formatearHoraTijuana(fecha = new Date()) {
  return {
    fechaLarga: new Intl.DateTimeFormat("es-MX", {
      timeZone: ZONA_TIJUANA,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(fecha),
    hora: new Intl.DateTimeFormat("es-MX", {
      timeZone: ZONA_TIJUANA,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(fecha),
    // GMT-8 en invierno / GMT-7 en verano (cambia solo con el DST)
    desfase: new Intl.DateTimeFormat("en-US", {
      timeZone: ZONA_TIJUANA,
      timeZoneName: "shortOffset",
    }).formatToParts(fecha).find((p) => p.type === "timeZoneName")?.value ?? "",
    // "Pacific Daylight Time" / "Pacific Standard Time" según toque
    nombreZona: new Intl.DateTimeFormat("es-MX", {
      timeZone: ZONA_TIJUANA,
      timeZoneName: "long",
    }).formatToParts(fecha).find((p) => p.type === "timeZoneName")?.value ?? "",
  };
}

export const hora = {
  data: new SlashCommandBuilder()
    .setName("hora")
    .setDescription("Consulta la hora en la taberna y allende los mares")
    .addSubcommand((sub) =>
      sub.setName("kyon").setDescription("La hora de Kyon (Tijuana, con cambio de horario)")
    ),

  async execute(interaction) {
    const { fechaLarga, hora: horaStr, desfase, nombreZona } = formatearHoraTijuana();
    return interaction.reply({
      embeds: [
        embed(
          TEMA.color.estrella,
          `🌵 En **Tijuana** son las **${horaStr}** del **${fechaLarga}**.\n` +
          `⏰ Zona: \`${ZONA_TIJUANA}\` (${nombreZona}, UTC${desfase.replace("GMT", "")})\n` +
          `*El tabernero ajusta este reloj solo con cada cambio de horario.* ⏳`,
          "🕰️ La hora de Kyon"
        ),
      ],
    });
  },
};
