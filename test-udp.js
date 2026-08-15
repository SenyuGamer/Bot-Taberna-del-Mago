import dgram from "node:dgram";
import dns from "node:dns/promises";

// Prueba UDP pura contra el endpoint de voz de Discord, imitando el IP discovery
// de @discordjs/voice. Sirve para saber si la red permite UDP al servidor de voz.
//
// Uso: node test-udp.js <endpoint> <puerto>   (ej: c-lax11-457cc923.discord.media 2096)

const host = process.argv[2];
const port = Number(process.argv[3]);

if (!host || !port) {
  console.error("Uso: node test-udp.js <host> <puerto>");
  process.exit(1);
}

console.log(`Resolviendo ${host}...`);
let ips;
try {
  ips = await dns.lookup(host, { all: true });
} catch (e) {
  console.error("❌ No se pudo resolver:", e.message);
  process.exit(1);
}
console.log("IPs:", ips.map((i) => i.address).join(", "));

for (const { address } of ips) {
  console.log(`\n▶ Probando UDP ${address}:${port}...`);
  const socket = dgram.createSocket("udp4");
  const ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;

  const discovery = Buffer.alloc(74);
  discovery.writeUInt16BE(1, 0);
  discovery.writeUInt16BE(70, 2);
  discovery.writeUInt32BE(ssrc, 4);

  socket.on("message", (msg) => {
    console.log(`✅ ${address}:${port} RESPONDE (${msg.length} bytes)`);
    if (msg.length >= 72) {
      const ip = msg.subarray(4, 68).toString("utf8").replace(/\0+$/g, "");
      const puerto = msg.readUInt16BE(68);
      console.log(`   → IP descubierta: ${ip}:${puerto} — ¡UDP FUNCIONA!`);
    }
    socket.close();
    process.exit(0);
  });

  socket.on("error", (e) => {
    console.error(`❌ ${address}:${port} error:`, e.message);
    socket.close();
  });

  socket.send(discovery, 0, discovery.length, port, address, (err) => {
    if (err) {
      console.error(`❌ No se pudo enviar a ${address}:${port}:`, err.message);
      socket.close();
    }
  });

  setTimeout(() => {
    console.error(`❌ ${address}:${port} NO RESPONDE en 5s (UDP bloqueado o sin ruta)`);
    socket.close();
  }, 5000);
}
