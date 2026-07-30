import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { unir, parar, getSesion, listarSesiones, canalGuardado } from "../voice/sessionManager.js";
import { TEMA, embed, embedError, esDMoAdmin } from "../utils.js";

const COLOR = 0x1db954; // verde música
const EMOJI = "🎵";

export const syncmusic = {
  data: new SlashCommandBuilder()
    .setName("syncmusic")
    .setDescription("Conecta el bot al canal de voz para sonar la música de Djinni/Owlbear")
    .addSubcommand((sub) =>
      sub
        .setName("unir")
        .setDescription("Conecta el bot al canal de voz (por defecto: donde estés tú)")
        .addChannelOption((opt) =>
          opt
            .setName("canal")
            .setDescription("Canal de voz destino (opcional)")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("parar").setDescription("Detiene la música y desconecta el bot del canal")
    )
    .addSubcommand((sub) =>
      sub.setName("estado").setDescription("Muestra las sesiones de música activas")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === "estado") {
      const sesiones = listarSesiones();
      if (sesiones.length === 0) {
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} No hay sesiones de música activas. Usa \`/syncmusic unir\` para enchufar el bot a un canal.`)],
        });
      }
      const lineas = sesiones.map((s) =>
        `• <#${s.canalId}> — **${s.fuentes}** fuente(s) sonando${s.pausado ? " (pausado)" : ""}`
      );
      return interaction.reply({
        embeds: [embed(COLOR, lineas.join("\n"), `${EMOJI} Sesiones de música`)],
      });
    }

    if (!esDMoAdmin(interaction)) {
      return interaction.reply({
        embeds: [embedError("Solo el DM o un administrador puede gestionar la música sincronizada.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === "parar") {
      const existia = parar(interaction.guildId);
      return interaction.reply({
        embeds: [embed(COLOR, existia
          ? `${EMOJI} Música detenida. El bot deja el escenario (hasta la próxima). 👋`
          : `${EMOJI} El bot no estaba en ningún canal de voz.`)],
      });
    }

    // -------- unir --------
    const canalElegido = interaction.options.getChannel("canal");
    const canalMiembro = interaction.member?.voice?.channelId
      ? interaction.guild.channels.cache.get(interaction.member.voice.channelId)
      : null;
    const canalGuardadoId = canalGuardado(interaction.guildId);
    const canalPrevio = canalGuardadoId
      ? interaction.guild.channels.cache.get(canalGuardadoId)
      : null;

    const canal = canalElegido ?? canalMiembro ?? canalPrevio;
    if (!canal || !canal.isVoiceBased()) {
      return interaction.reply({
        embeds: [embedError("No encuentro el canal de voz. Conéctate a uno y repite, o indícalo con la opción `canal`.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();
    try {
      await unir(interaction.guild, canal);
    } catch (error) {
      return interaction.editReply({ embeds: [embedError(error.message)] });
    }

    const urlDjinni = process.env.DJINNI_PUBLIC_URL
      ? `\n\n🧞 *Djinni sincronizado por tu túnel: ${process.env.DJINNI_PUBLIC_URL} (el fork se sirve desde ahí; pon play en Owlbear y sonará aquí).*\n🎶 O usa \`/musica url\` con un enlace de YouTube.`
      : "";
    return interaction.editReply({
      embeds: [
        embed(
          COLOR,
          `${EMOJI} **Conectado a ${canal.name}**.\nTodo lo que el DM ponga en Djinni sonará en esta llamada. Cambia de pista en Owlbear y la cambio yo aquí.${urlDjinni}\n\n*Para cortar: \`/syncmusic parar\`.*`,
          `${EMOJI} La taberna suena`
        ),
      ],
    });
  },
};
