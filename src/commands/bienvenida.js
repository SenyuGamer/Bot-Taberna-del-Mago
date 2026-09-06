import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import {
  getConfig,
  setWelcomeChannel,
  setGoodbyeChannel,
  setWelcomeEnabled,
  setGoodbyeEnabled,
  setWelcomeEmbed,
  setGoodbyeEmbed,
} from "../db.js";
import { TEMA, embed, embedError, esAdmin } from "../utils.js";
import { sendTestMessage, PLACEHOLDERS_LIST } from "../welcomeHandler.js";

const COLOR = 0x237aeb;
const EMOJI = "🚪";

export const bienvenida = {
  data: new SlashCommandBuilder()
    .setName("bienvenida")
    .setDescription("Configura los mensajes de bienvenida y despedida del servidor")

    // /bienvenida canal-entrada #canal
    .addSubcommand((sub) =>
      sub
        .setName("canal-entrada")
        .setDescription("Configura el canal donde se envían las bienvenidas")
        .addChannelOption((opt) =>
          opt
            .setName("canal")
            .setDescription("Canal de texto para bienvenidas")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )

    // /bienvenida canal-salida #canal
    .addSubcommand((sub) =>
      sub
        .setName("canal-salida")
        .setDescription("Configura el canal donde se envían las despedidas")
        .addChannelOption((opt) =>
          opt
            .setName("canal")
            .setDescription("Canal de texto para despedidas")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )

    // /bienvenida activar entrada|salida
    .addSubcommand((sub) =>
      sub
        .setName("activar")
        .setDescription("Activa los mensajes de entrada o salida")
        .addStringOption((opt) =>
          opt
            .setName("tipo")
            .setDescription("¿Qué activar?")
            .setRequired(true)
            .addChoices(
              { name: "Entrada (bienvenida)", value: "entrada" },
              { name: "Salida (despedida)", value: "salida" }
            )
        )
    )

    // /bienvenida desactivar entrada|salida
    .addSubcommand((sub) =>
      sub
        .setName("desactivar")
        .setDescription("Desactiva los mensajes de entrada o salida")
        .addStringOption((opt) =>
          opt
            .setName("tipo")
            .setDescription("¿Qué desactivar?")
            .setRequired(true)
            .addChoices(
              { name: "Entrada (bienvenida)", value: "entrada" },
              { name: "Salida (despedida)", value: "salida" }
            )
        )
    )

    // /bienvenida mensaje entrada|salida <json>
    .addSubcommand((sub) =>
      sub
        .setName("mensaje")
        .setDescription("Configura el JSON del embed de entrada o salida (de Discohook, etc.)")
        .addStringOption((opt) =>
          opt
            .setName("tipo")
            .setDescription("¿Qué mensaje configurar?")
            .setRequired(true)
            .addChoices(
              { name: "Entrada (bienvenida)", value: "entrada" },
              { name: "Salida (despedida)", value: "salida" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("json")
            .setDescription("JSON del mensaje/embed (de Discohook, etc.)")
            .setRequired(true)
        )
    )

    // /bienvenida probar entrada|salida
    .addSubcommand((sub) =>
      sub
        .setName("probar")
        .setDescription("Envía un mensaje de prueba en el canal configurado")
        .addStringOption((opt) =>
          opt
            .setName("tipo")
            .setDescription("¿Qué probar?")
            .setRequired(true)
            .addChoices(
              { name: "Entrada (bienvenida)", value: "entrada" },
              { name: "Salida (despedida)", value: "salida" }
            )
        )
    )

    // /bienvenida ver
    .addSubcommand((sub) =>
      sub.setName("ver").setDescription("Muestra la configuración actual de bienvenida/despedida")
    )

    // /bienvenida placeholders
    .addSubcommand((sub) =>
      sub.setName("placeholders").setDescription("Lista los placeholders disponibles para los mensajes")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // Todos los subcomandos (excepto ver y placeholders) requieren admin
    if (!["ver", "placeholders"].includes(sub) && !esAdmin(interaction)) {
      return interaction.reply({
        embeds: [embedError("Solo un administrador puede configurar la bienvenida.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    // --- canal-entrada ---
    if (sub === "canal-entrada") {
      const canal = interaction.options.getChannel("canal");
      setWelcomeChannel(guildId, canal.id);
      return interaction.reply({
        embeds: [
          embed(COLOR, `${EMOJI} Canal de bienvenida configurado: <#${canal.id}>.\nUsa \`/bienvenida activar entrada\` para activar los mensajes.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // --- canal-salida ---
    if (sub === "canal-salida") {
      const canal = interaction.options.getChannel("canal");
      setGoodbyeChannel(guildId, canal.id);
      return interaction.reply({
        embeds: [
          embed(COLOR, `${EMOJI} Canal de despedida configurado: <#${canal.id}>.\nUsa \`/bienvenida activar salida\` para activar los mensajes.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // --- activar ---
    if (sub === "activar") {
      const tipo = interaction.options.getString("tipo");
      if (tipo === "entrada") {
        const config = getConfig(guildId);
        if (!config.welcome_channel_id) {
          return interaction.reply({
            embeds: [embedError("Primero configura un canal con `/bienvenida canal-entrada #canal`.")],
            flags: MessageFlags.Ephemeral,
          });
        }
        setWelcomeEnabled(guildId, true);
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} ✅ Mensajes de **bienvenida** activados en <#${config.welcome_channel_id}>.`)],
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const config = getConfig(guildId);
        if (!config.goodbye_channel_id) {
          return interaction.reply({
            embeds: [embedError("Primero configura un canal con `/bienvenida canal-salida #canal`.")],
            flags: MessageFlags.Ephemeral,
          });
        }
        setGoodbyeEnabled(guildId, true);
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} ✅ Mensajes de **despedida** activados en <#${config.goodbye_channel_id}>.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // --- desactivar ---
    if (sub === "desactivar") {
      const tipo = interaction.options.getString("tipo");
      if (tipo === "entrada") {
        setWelcomeEnabled(guildId, false);
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} ❌ Mensajes de **bienvenida** desactivados.`)],
          flags: MessageFlags.Ephemeral,
        });
      } else {
        setGoodbyeEnabled(guildId, false);
        return interaction.reply({
          embeds: [embed(COLOR, `${EMOJI} ❌ Mensajes de **despedida** desactivados.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // --- mensaje (configurar JSON del embed) ---
    if (sub === "mensaje") {
      const tipo = interaction.options.getString("tipo");
      const jsonStr = interaction.options.getString("json");

      // Validar que sea JSON válido
      try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed.embeds && !parsed.content) {
          return interaction.reply({
            embeds: [embedError("El JSON debe tener al menos `content` o `embeds`.")],
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        return interaction.reply({
          embeds: [embedError("El JSON no es válido. Cópialo desde Discohook u otra herramienta de embeds.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (tipo === "entrada") {
        setWelcomeEmbed(guildId, jsonStr);
        return interaction.reply({
          embeds: [
            embed(
              COLOR,
              `${EMOJI} ✅ Mensaje de **bienvenida** actualizado.\nUsa \`/bienvenida probar entrada\` para ver cómo queda.`
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else {
        setGoodbyeEmbed(guildId, jsonStr);
        return interaction.reply({
          embeds: [
            embed(
              COLOR,
              `${EMOJI} ✅ Mensaje de **despedida** actualizado.\nUsa \`/bienvenida probar salida\` para ver cómo queda.`
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // --- probar ---
    if (sub === "probar") {
      const tipo = interaction.options.getString("tipo");
      const result = await sendTestMessage(interaction, tipo);

      if (!result.ok) {
        const msg =
          result.reason === "no-channel"
            ? `No hay canal configurado para ${tipo === "entrada" ? "bienvenida" : "despedida"}. Usa \`/bienvenida canal-${tipo}\`.`
            : `El canal configurado no es válido o no tengo acceso.`;
        return interaction.reply({
          embeds: [embedError(msg)],
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        embeds: [embed(COLOR, `${EMOJI} Mensaje de prueba enviado en <#${result.channelId}>.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // --- ver ---
    if (sub === "ver") {
      const config = getConfig(guildId);
      const lines = [
        `**Bienvenida (entrada)**`,
        `Estado: ${config.welcome_enabled ? "✅ Activada" : "❌ Desactivada"}`,
        `Canal: ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : "No configurado"}`,
        `Mensaje: ${config.welcome_embed_json ? "Personalizado ✏️" : "Por defecto"}`,
        ``,
        `**Despedida (salida)**`,
        `Estado: ${config.goodbye_enabled ? "✅ Activada" : "❌ Desactivada"}`,
        `Canal: ${config.goodbye_channel_id ? `<#${config.goodbye_channel_id}>` : "No configurado"}`,
        `Mensaje: ${config.goodbye_embed_json ? "Personalizado ✏️" : "Por defecto"}`,
      ];

      return interaction.reply({
        embeds: [embed(COLOR, lines.join("\n"), `${EMOJI} Configuración de Bienvenida/Despedida`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // --- placeholders ---
    if (sub === "placeholders") {
      const lines = PLACEHOLDERS_LIST.map((p) => `\`${p.placeholder}\` → ${p.desc}`);
      return interaction.reply({
        embeds: [
          embed(
            COLOR,
            `Usa estos placeholders en tu JSON de embed. Se reemplazarán automáticamente:\n\n${lines.join("\n")}`,
            `${EMOJI} Placeholders disponibles`
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
