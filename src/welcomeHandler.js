import { EmbedBuilder } from "discord.js";
import { getConfig } from "./db.js";

// ---------- Placeholders ----------

/**
 * Construye el mapa de placeholders disponibles.
 * Sintaxis en los mensajes: $placeholder$
 */
function buildPlaceholders(member) {
  const guild = member.guild;
  const user = member.user;
  const now = new Date();

  return {
    // Usuario
    username: user.username,
    displayname: member.displayName ?? user.displayName ?? user.username,
    usertag: user.tag,
    usermention: `<@${user.id}>`,
    useravatar: user.displayAvatarURL({ size: 512 }),
    userid: user.id,

    // Servidor
    servername: guild.name,
    servericon: guild.iconURL({ size: 512 }) ?? "",
    serverid: guild.id,
    membercount: String(guild.memberCount),
    // Alias en español del JSON del usuario
    servernumbers: String(guild.memberCount),

    // Fechas
    createddate: user.createdAt.toLocaleDateString("es-ES"),
    joineddate: (member.joinedAt ?? now).toLocaleDateString("es-ES"),
  };
}

/**
 * Reemplaza todos los $placeholder$ en un string.
 */
function replacePlaceholders(text, placeholders) {
  if (typeof text !== "string") return text;
  return text.replace(/\$([a-zA-Z_]+)\$/g, (match, key) => {
    const lower = key.toLowerCase();
    return lower in placeholders ? placeholders[lower] : match;
  });
}

/**
 * Reemplaza placeholders recursivamente en todo un objeto JSON (strings, arrays, objetos).
 */
function deepReplace(obj, placeholders) {
  if (typeof obj === "string") return replacePlaceholders(obj, placeholders);
  if (Array.isArray(obj)) return obj.map((item) => deepReplace(item, placeholders));
  if (obj !== null && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepReplace(value, placeholders);
    }
    return result;
  }
  return obj;
}

// ---------- Embeds por defecto ----------

const DEFAULT_WELCOME_JSON = JSON.stringify({
  content: "",
  embeds: [
    {
      title: "Welcome",
      description:
        "Dad todos la bienvenida a $username$, Esperamos te la pases genial en nuestra $servername$. Eres el/la $servernumbers$ miembr@ del server.",
      color: 2326507,
      fields: [],
      image: {
        url: "https://media.discordapp.net/attachments/1366483461455610067/1546259071525716008/entrada.jpg?ex=6a9f217a&is=6a9dcffa&hm=e8344e4884af2d7bb9c02a800172d24d33d7d9eae4725adef9b4854d6b280c83&=&format=webp",
      },
    },
  ],
});

const DEFAULT_GOODBYE_JSON = JSON.stringify({
  content: "",
  embeds: [
    {
      title: "Byee :c",
      description: "Parece que $username$ nos ha abandonado... quedamos $servernumbers$",
      color: 0xe74c3c,
      fields: [],
      image: {
        url: "https://media.discordapp.net/attachments/1366483461455610067/1546259071835971684/salida.jpg?ex=6a9f217a&is=6a9dcffa&hm=0f1b0c4fbc11b1938430d012dde4acb707a5419dfd94c4c3275c5a5dc855cd89&=&format=webp",
      },
    },
  ],
});

// ---------- Construir payload de Discord desde JSON guardado ----------

/**
 * Toma el JSON crudo (del usuario o el default), reemplaza placeholders,
 * y devuelve un objeto listo para `channel.send(payload)`.
 */
function buildPayload(jsonString, member) {
  const placeholders = buildPlaceholders(member);
  const raw = JSON.parse(jsonString);
  const replaced = deepReplace(raw, placeholders);

  // Construir el payload que Discord.js acepta
  const payload = {};

  if (replaced.content) payload.content = replaced.content;

  if (Array.isArray(replaced.embeds) && replaced.embeds.length > 0) {
    payload.embeds = replaced.embeds.map((e) => {
      const builder = new EmbedBuilder();
      if (e.title) builder.setTitle(e.title);
      if (e.description) builder.setDescription(e.description);
      if (e.color != null) builder.setColor(e.color);
      if (e.url) builder.setURL(e.url);
      if (e.timestamp) builder.setTimestamp(new Date(e.timestamp));
      if (e.footer) {
        builder.setFooter({
          text: e.footer.text ?? "",
          iconURL: e.footer.icon_url ?? undefined,
        });
      }
      if (e.author) {
        builder.setAuthor({
          name: e.author.name ?? "",
          iconURL: e.author.icon_url ?? undefined,
          url: e.author.url ?? undefined,
        });
      }
      if (e.thumbnail?.url) builder.setThumbnail(e.thumbnail.url);
      if (e.image?.url) builder.setImage(e.image.url);
      if (Array.isArray(e.fields)) {
        for (const f of e.fields) {
          if (f.name && f.value) {
            builder.addFields({ name: f.name, value: f.value, inline: !!f.inline });
          }
        }
      }
      return builder;
    });
  }

  return payload;
}

// ---------- Handlers públicos ----------

/**
 * Maneja el evento guildMemberAdd: envía el embed de bienvenida.
 */
export async function handleMemberJoin(member) {
  try {
    const config = getConfig(member.guild.id);
    if (!config.welcome_enabled) return;
    if (!config.welcome_channel_id) return;

    const channel = await member.guild.channels.fetch(config.welcome_channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;

    const jsonTemplate = config.welcome_embed_json || DEFAULT_WELCOME_JSON;
    const payload = buildPayload(jsonTemplate, member);
    await channel.send(payload);
  } catch (error) {
    console.error("❌ Error enviando mensaje de bienvenida:", error);
  }
}

/**
 * Maneja el evento guildMemberRemove: envía el embed de despedida.
 */
export async function handleMemberLeave(member) {
  try {
    const config = getConfig(member.guild.id);
    if (!config.goodbye_enabled) return;
    if (!config.goodbye_channel_id) return;

    const channel = await member.guild.channels.fetch(config.goodbye_channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;

    const jsonTemplate = config.goodbye_embed_json || DEFAULT_GOODBYE_JSON;
    const payload = buildPayload(jsonTemplate, member);
    await channel.send(payload);
  } catch (error) {
    console.error("❌ Error enviando mensaje de despedida:", error);
  }
}

/**
 * Envía un mensaje de prueba (usa al miembro que ejecuta el comando como si fuera nuevo).
 */
export async function sendTestMessage(interaction, tipo) {
  const config = getConfig(interaction.guildId);
  const isWelcome = tipo === "entrada";

  const channelId = isWelcome ? config.welcome_channel_id : config.goodbye_channel_id;
  if (!channelId) return { ok: false, reason: "no-channel" };

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return { ok: false, reason: "invalid-channel" };

  const jsonTemplate = isWelcome
    ? config.welcome_embed_json || DEFAULT_WELCOME_JSON
    : config.goodbye_embed_json || DEFAULT_GOODBYE_JSON;

  const payload = buildPayload(jsonTemplate, interaction.member);
  await channel.send(payload);
  return { ok: true, channelId };
}

/**
 * Lista de placeholders disponibles para mostrar al usuario.
 */
export const PLACEHOLDERS_LIST = [
  { placeholder: "$username$", desc: "Nombre de usuario" },
  { placeholder: "$displayname$", desc: "Nombre mostrado / apodo" },
  { placeholder: "$usertag$", desc: "Tag completo (user#0)" },
  { placeholder: "$usermention$", desc: "Mención (@usuario)" },
  { placeholder: "$useravatar$", desc: "URL del avatar" },
  { placeholder: "$userid$", desc: "ID del usuario" },
  { placeholder: "$servername$", desc: "Nombre del servidor" },
  { placeholder: "$servericon$", desc: "URL del icono del servidor" },
  { placeholder: "$serverid$", desc: "ID del servidor" },
  { placeholder: "$membercount$", desc: "Nº total de miembros" },
  { placeholder: "$servernumbers$", desc: "Nº total de miembros (alias)" },
  { placeholder: "$createddate$", desc: "Fecha de creación de la cuenta" },
  { placeholder: "$joineddate$", desc: "Fecha de ingreso al servidor" },
];
