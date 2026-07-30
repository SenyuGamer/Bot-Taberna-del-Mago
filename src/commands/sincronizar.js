import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { iniciarFlujoOAuth, guardarTokens, iniciarTwitch } from "../twitch.js";
import { TEMA, embed, embedError, esDMoAdmin, enviarRegistro } from "../utils.js";

const COLOR = TEMA.color.twitch;
let sincronizando = false;

export const sincronizar = {
  data: new SlashCommandBuilder()
    .setName("sincronizar")
    .setDescription("Sincroniza las integraciones externas de la taberna")
    .addSubcommand((sub) =>
      sub
        .setName("twitch")
        .setDescription("Vincula el canal de Twitch para detectar canjes de inspiración (DM/admins)")
    ),

  async execute(interaction) {
    if (!esDMoAdmin(interaction)) {
      return interaction.reply({
        embeds: [embedError("Solo el DM o un administrador puede sincronizar Twitch.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sincronizando) {
      return interaction.reply({
        embeds: [embedError("Ya hay una sincronización de Twitch en curso. Termínala o espera a que caduque.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
      return interaction.reply({
        embeds: [embedError("Faltan `TWITCH_CLIENT_ID` y/o `TWITCH_CLIENT_SECRET` en el archivo `.env` del bot.\nCrea una app en https://dev.twitch.tv/console/apps (o reutiliza la de OwlTwitch) y vuelve a intentarlo.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    sincronizando = true;
    try {
      const flujo = iniciarFlujoOAuth();

      const avisoLocal = flujo.redirectUri.startsWith("http://localhost")
        ? `\n\n⚠️ **Ojo**: el bot está usando \`${flujo.redirectUri}\` porque falta \`TWITCH_CALLBACK_URL\` en el .env del bot. Si el bot corre en un servidor, debes configurar en su .env la URL pública de tu túnel y reiniciar; de lo contrario Twitch te dirá *redirect_mismatch*.`
        : "";

      await interaction.reply({
        embeds: [
          embed(
            COLOR,
            `**1.** Abre el enlace e inicia sesión con la **cuenta del canal**:\n[🔗 Autorizar en Twitch](${flujo.authUrl})\n\n` +
            `**2.** Acepta los permisos y vuelve aquí: en cuanto termines confirmo por este mismo mensaje. *(Tienes 5 minutos; solo tú ves este mensaje.)*\n\n` +
            `⚙️ *Solo la primera vez: en https://dev.twitch.tv/console/apps → tu aplicación, registra esta URL de redirección:*\n\`${flujo.redirectUri}\`${avisoLocal}`,
            "🦉 Sincronizar Twitch"
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });

      const tokens = await flujo.promesa;
      guardarTokens(tokens);
      const credenciales = await iniciarTwitch(interaction.client);

      if (credenciales) {
        await interaction.followUp({
          embeds: [
            embed(
              COLOR,
              `✅ Twitch sincronizado con el canal **@${credenciales.login}**.\nLos canjes que coincidan con \`${process.env.TWITCH_REWARD_REGEX || "inspiraci"}\` sumarán **+1** ${TEMA.emoji.inspiracion} al DM y se anunciarán en el canal de registros.`
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        await enviarRegistro(
          interaction.guild,
          embed(COLOR, `**${interaction.user.displayName}** sincronizó la taberna con el canal de Twitch **@${credenciales.login}**. 🦉`, "🦉 Registro de Twitch")
        );
      } else {
        await interaction.followUp({
          embeds: [embedError("Los tokens se guardaron pero no se pudieron validar con Twitch. Revisa la consola del bot.")],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      const mensaje = `❌ No se pudo sincronizar Twitch: **${error.message}**`;
      if (interaction.replied) {
        await interaction.followUp({ embeds: [embedError(mensaje)], flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ embeds: [embedError(mensaje)], flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } finally {
      sincronizando = false;
    }
  },
};
