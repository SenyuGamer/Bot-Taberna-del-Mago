import { REST, Routes } from "discord.js";
import { estrellitas, estrellitasNegras } from "./src/commands/estrellitas.js";
import { inspiracion } from "./src/commands/inspiracion.js";
import { dm } from "./src/commands/dm.js";
import { registros } from "./src/commands/registros.js";
import { sincronizar } from "./src/commands/sincronizar.js";
import { hora } from "./src/commands/hora.js";
import { syncmusic } from "./src/commands/syncmusic.js";
import { musica } from "./src/commands/musica.js";
import { testmusic } from "./src/commands/testmusic.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("❌ Faltan DISCORD_TOKEN y/o CLIENT_ID en el archivo .env");
  process.exit(1);
}

const body = [estrellitas, estrellitasNegras, inspiracion, dm, registros, sincronizar, hora, syncmusic, musica, testmusic].map((c) =>
  c.data.toJSON()
);

const rest = new REST().setToken(DISCORD_TOKEN);

const urlInvitacion =
  `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}` +
  `&permissions=2147503104&scope=bot%20applications.commands`;

try {
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log(`✅ ${body.length} comandos registrados en el servidor (GUILD_ID ${GUILD_ID}).`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log(`✅ ${body.length} comandos registrados globalmente (pueden tardar hasta 1 hora en aparecer).`);
  }
} catch (error) {
  const code = error.code ?? error.rawError?.code;
  console.error(`\n❌ Discord rechazó el registro de comandos (${error.status ?? "?"} - código ${code}: ${error.rawError?.message ?? error.message})\n`);

  if (code === 50001) {
    console.error("Causa: la aplicación no tiene acceso a ese servidor con el scope 'applications.commands'.");
    console.error("Esto pasa cuando el bot fue invitado solo con el scope 'bot', o el CLIENT_ID no coincide con la aplicación del token.\n");
    console.error("Solución:");
    console.error("  1. Abre esta URL en tu navegador y vuelve a autorizar el bot (necesitas 'Administrar servidor'):");
    console.error(`     ${urlInvitacion}`);
    console.error("  2. Asegúrate de que CLIENT_ID sea el 'Application ID' de la MISMA aplicación de donde sacaste el token.");
    console.error("  3. Vuelve a ejecutar: bun run deploy");
  } else if (error.status === 401) {
    console.error("Causa: DISCORD_TOKEN es inválido. Genera uno nuevo en el portal (Bot > Reset Token) y pégalo en .env.");
  } else if (code === 10004) {
    console.error(`Causa: el GUILD_ID (${GUILD_ID}) no corresponde a ningún servidor. Activa el modo desarrollador en Discord, clic derecho al servidor > 'Copiar ID del servidor'.`);
  } else {
    console.error(error);
  }
  process.exit(1);
}
