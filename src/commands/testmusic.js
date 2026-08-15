import { SlashCommandBuilder, MessageFlags, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  entersState,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { Mixer } from "../voice/mixer.js";
import { crearPipeline } from "../voice/pipeline.js";
import { embed, embedError } from "../utils.js";

const COLOR = 0x1db954;
const EMOJI = "TEST";

export const testmusic = {
  data: new SlashCommandBuilder()
    .setName("testmusic")
    .setDescription("Prueba de musica: conecta al canal, reproduce el enlace y se retira al terminar")
    .addChannelOption((opt) =>
      opt
        .setName("canal")
        .setDescription("Canal de voz al que conectarse")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    )
    .addStringOption((opt) => opt.setName("link").setDescription("Enlace de YouTube").setRequired(true)),

  async execute(interaction) {
    const canal = interaction.options.getChannel("canal", true);
    const link = interaction.options.getString("link", true);

    if (!/^https?:\/\//i.test(link)) {
      return interaction.reply({
        embeds: [embedError("Eso no parece un enlace valido.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const perms = canal.permissionsFor(interaction.client.user.id);
    if (!perms?.has(["ViewChannel", "Connect", "Speak"])) {
      return interaction.reply({
        embeds: [embedError(`El bot no tiene permisos de Ver canal/Conectar/Hablar en <#${canal.id}>.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();
    const aviso = (texto) =>
      interaction.followUp({ embeds: [embed(COLOR, `${EMOJI} ${texto}`)] }).catch(() => {});

    let pipeline = null;
    let terminado = false;
    const finalizar = async (texto) => {
      if (terminado) return;
      terminado = true;
      try { pipeline?.detener(); } catch {}
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.destroy(); } catch {}
      }
      await aviso(texto);
    };

    const connection = joinVoiceChannel({
      channelId: canal.id,
      guildId: canal.guild.id,
      adapterCreator: canal.guild.voiceAdapterCreator,
    });

    connection.on("stateChange", (_v, n) => {
      console.log(`testmusic (${canal.guild.name}): ${n.status}`);
      if (n.status === VoiceConnectionStatus.Destroyed) {
        try { pipeline?.detener(); } catch {}
      }
    });
    connection.on("error", (e) => {
      console.error("testmusic error:", e.message);
      finalizar(`Error de conexion de voz: ${e.message}`);
    });
    connection.on("debug", (m) => console.log("testmusic debug:", m));

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      console.error("testmusic: no llego a Ready");
      await finalizar("No pude conectarme al canal de voz (revisa los logs en la Pi).");
      return;
    }

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const mixer = new Mixer();
    const recurso = createAudioResource(mixer.salida, { inputType: StreamType.Raw });
    player.play(recurso);
    connection.subscribe(player);
    player.on("error", (e) => console.error("testmusic player error:", e.message));

    await aviso(`Conectado a <#${canal.id}>. Reproduciendo <${link}>...`);

    mixer.agregarFuente("test", 1);
    pipeline = crearPipeline({
      url: link,
      onDatos: (bytes) => mixer.empujar("test", bytes),
      onError: (e) => {
        console.error("testmusic pipeline:", e.message);
        finalizar(`Fallo al reproducir: ${e.message}`);
      },
      onFin: () => finalizar("Reproduccion terminada. Me retiro del canal."),
    });

    try {
      await pipeline.esperarPrimerAudio(25_000);
      await aviso(`Sonando: <${link}>`);
    } catch (e) {
      console.error("testmusic sin audio:", e.message);
      await finalizar(`No se obtuvo audio: ${e.message}`);
      return;
    }

    const seguro = setTimeout(() => {
      console.log("testmusic: timeout de seguridad (3 min)");
      finalizar("Fin de la prueba (tiempo maximo de 3 min).");
    }, 3 * 60 * 1000);
    seguro.unref?.();
  },
};
