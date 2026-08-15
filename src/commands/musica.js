import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import {
  unir,
  parar,
  getSesion,
  agregarFuente,
  quitarFuentesManuales,
  canalGuardado,
} from "../voice/sessionManager.js";
import { listarCancionesMenu } from "../db.js";
import { TEMA, embed, embedError, esDMoAdmin } from "../utils.js";

const COLOR = 0x1db954; // verde música
const EMOJI = "🎵";

export const musica = {
  data: new SlashCommandBuilder()
    .setName("musica")
    .setDescription("Música: conectar el bot, reproducir un enlace o el menú del DM")
    .addSubcommand((sub) =>
      sub
        .setName("unir")
        .setDescription("Conecta el bot al canal de voz (donde estés tú o el indicado)")
        .addChannelOption((opt) =>
          opt
            .setName("canal")
            .setDescription("Canal de voz destino (opcional)")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("url")
        .setDescription("Reproduce un enlace de YouTube (o URL que entienda yt-dlp)")
        .addStringOption((opt) =>
          opt.setName("enlace").setDescription("Enlace de YouTube del tema").setRequired(true)
        )
        .addBooleanOption((opt) => opt.setName("loop").setDescription("Repetir en bucle (ambiente)"))
        .addIntegerOption((opt) =>
          opt.setName("volumen").setDescription("Volumen 1-100 (por defecto 80)").setMinValue(1).setMaxValue(100)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("menu")
        .setDescription("Muestra las canciones guardadas en el menú del DM")
        .addBooleanOption((opt) => opt.setName("reproducir").setDescription("Pide al DM que reproduzca una con /djinni menu"))
    )
    .addSubcommand((sub) =>
      sub
        .setName("parar")
        .setDescription("Quita tu música manual actual")
        .addBooleanOption((opt) => opt.setName("todo").setDescription("Quitar toda la música y desconectar (DM/admins)"))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // -------- menu --------
    if (sub === "menu") {
      const canciones = listarCancionesMenu();
      if (canciones.length === 0) {
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} El menú del DM está vacío. El DM puede añadir canciones desde el panel de Owlbear (extensión DJINNI).`)],
        });
      }
      const lineas = canciones.map((c) => `${c.icono || "🎵"} **${c.nombre}**${c.loop ? " 🔁" : ""} — <${c.url}>`);
      return interaction.reply({
        embeds: [embed(COLOR, lineas.join("\n"), `${EMOJI} Canciones del menú`)],
      });
    }

    // -------- parar --------
    if (sub === "parar") {
      const todo = interaction.options.getBoolean("todo") ?? false;
      if (todo) {
        if (!esDMoAdmin(interaction)) {
          return interaction.reply({
            embeds: [embedError("Solo el DM o un administrador puede parar toda la música y desconectar.")],
            flags: MessageFlags.Ephemeral,
          });
        }
        const existia = parar(interaction.guildId);
        return interaction.reply({
          embeds: [embed(COLOR, existia
            ? `${EMOJI} Música detenida. El bot deja el escenario. 👋`
            : `${EMOJI} El bot no estaba conectado a ningún canal.`)],
        });
      }
      const quitadas = quitarFuentesManuales(interaction.guildId, { soloDe: interaction.user.id });
      return interaction.reply({
        embeds: [embed(COLOR, quitadas > 0
          ? `${EMOJI} Quité **${quitadas}** de tus temas.`
          : `${EMOJI} No tenías temas manuales sonando.`)],
      });
    }

    // -------- unir --------
    if (sub === "unir") {
      const canalElegido = interaction.options.getChannel("canal");
      const canalMiembro = interaction.member?.voice?.channelId
        ? interaction.guild.channels.cache.get(interaction.member.voice.channelId)
        : null;
      const canalGuardadoId = canalGuardado(interaction.guildId);
      const canalPrevio = canalGuardadoId ? interaction.guild.channels.cache.get(canalGuardadoId) : null;

      const canal = canalElegido ?? canalMiembro ?? canalPrevio;
      if (!canal || !canal.isVoiceBased()) {
        return interaction.reply({
          embeds: [embedError("No encuentro el canal de voz. Conéctate a uno y repite, o indícalo con la opción `canal`.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();
      try {
        await unir(interaction.guild, canal, interaction.client.user.id);
      } catch (error) {
        return interaction.editReply({ embeds: [embedError(error.message)] });
      }
      return interaction.editReply({
        embeds: [
          embed(
            COLOR,
            `${EMOJI} **Conectado a ${canal.name}**.\n` +
            `Pon música con \`/musica url\`, elige del menú del DM desde Owlbear (\`/djinni\`), o guárdalas con el propio panel DJINNI.\n\n*Para cortar: \`/musica parar todo\`.*`,
            `${EMOJI} La taberna suena`
          ),
        ],
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

    const sesion = getSesion(interaction.guildId);
    if (!sesion) {
      return interaction.reply({
        embeds: [embedError("El bot no está en un canal de voz. Usa primero `/musica unir`.")],
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
      return interaction.editReply({ embeds: [embedError("La sesión de música desapareció. Usa `/musica unir` de nuevo.")] });
    }

    try {
      await creado.promesa;
      return interaction.editReply({
        embeds: [
          embed(
            COLOR,
            `${EMOJI} Sonando: <${url}>${loop ? " 🔁" : ""} · volumen ${Math.round(volumen * 100)}%\n*Añadido por ${interaction.user.displayName}. Para quitarlo: \`/musica parar\`.*`,
            `${EMOJI} Tema pinchado`
          ),
        ],
      });
    } catch (error) {
      return interaction.editReply({ embeds: [embedError(`No pude reproducir ese enlace: ${error.message}`)] });
    }
  },
};