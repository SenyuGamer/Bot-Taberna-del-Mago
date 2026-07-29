import { iniciarFlujoOAuth, guardarTokens } from "./src/twitch.js";

// Alternativa por terminal al comando de Discord /sincronizar twitch.
// Flujo OAuth de una sola vez (versión mínima del twitch-auth.ts de OwlTwitch)
// para generar el token de USUARIO del canal con scope channel:read:redemptions.

if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
  console.error("❌ Configura TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET en .env antes de ejecutar esto.");
  process.exit(1);
}

console.log("\n🦉 Generador de token de Twitch para La Taberna del Mago\n");

const flujo = iniciarFlujoOAuth();

console.log("1. En https://dev.twitch.tv/console/apps → tu aplicación, añade esta URL de redirección:");
console.log(`   ${flujo.redirectUri}\n`);
console.log("2. Abre esta URL en tu navegador e inicia sesión con la cuenta DEL CANAL:\n");
console.log(`   ${flujo.authUrl}\n`);
console.log("Esperando la autorización (5 min máximo, Ctrl+C para cancelar)...\n");

try {
  const tokens = await flujo.promesa;
  guardarTokens(tokens);
  console.log("✅ ¡Token generado y guardado en data/twitch-token.json!");
  console.log("   (Si prefieres tenerlo en .env, copia estas líneas:)\n");
  console.log(`TWITCH_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`TWITCH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log("Reinicia el bot con: npm start");
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
