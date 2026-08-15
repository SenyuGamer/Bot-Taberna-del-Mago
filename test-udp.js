import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";

// Diagnóstico de red de la Pi: ¿UDP funciona en general? ¿Llega a Discord?
// Uso: node test-udp.js <endpoint> <puerto>   (ej: c-lax11-457cc923.discord.media 2096)

const host = process.argv[2];
const port = Number(process.argv[3]);

if (!host || !port) {
  console.error("Uso: node test-udp.js <host> <puerto>");
  process.exit(1);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. Control: UDP a Cloudflare DNS ----------
function probarUDP(nombre, address, puerto, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const t = setTimeout(() => {
      socket.close();
      console.log(`❌ ${nombre} (${address}:${puerto}) NO RESPONDE en ${timeoutMs / 1000}s`);
      resolve(false);
    }, timeoutMs);
    socket.on("message", (msg) => {
      clearTimeout(t);
      socket.close();
      console.log(`✅ ${nombre} (${address}:${puerto}) RESPONDE (${msg.length} bytes) — UDP OK`);
      resolve(true);
    });
    socket.on("error", (e) => {
      clearTimeout(t);
      socket.close();
      console.log(`❌ ${nombre} (${address}:${puerto}) error: ${e.message}`);
      resolve(false);
    });
    const payload = Buffer.alloc(74);
    payload.writeUInt16BE(1, 0);
    payload.writeUInt16BE(70, 2);
    payload.writeUInt32BE((Math.random() * 0xffffffff) >>> 0, 4);
    socket.send(payload, 0, payload.length, puerto, address, (err) => {
      if (err) {
        clearTimeout(t);
        socket.close();
        console.log(`❌ ${nombre} no se pudo enviar: ${err.message}`);
        resolve(false);
      }
    });
  });
}

// ---------- 1b. STUN (UDP a puerto alto, siempre responde) ----------
function probarSTUN(nombre, address, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const t = setTimeout(() => {
      socket.close();
      console.log(`❌ ${nombre} (${address}:19302) STUN NO RESPONDE en ${timeoutMs / 1000}s — UDP puertos altos bloqueado`);
      resolve(false);
    }, timeoutMs);
    socket.on("message", (msg) => {
      clearTimeout(t);
      socket.close();
      const type = msg.readUInt16BE(0);
      console.log(`✅ ${nombre} (${address}:19302) STUN RESPONDE (type 0x${type.toString(16)}) — UDP puertos altos OK`);
      resolve(true);
    });
    socket.on("error", (e) => {
      clearTimeout(t);
      socket.close();
      console.log(`❌ ${nombre} (${address}:19302) error: ${e.message}`);
      resolve(false);
    });
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); // Binding Request
    msg.writeUInt16BE(0x0000, 2); // length
    msg.writeUInt32BE(0x2112a442, 4); // magic cookie
    for (let i = 0; i < 12; i++) msg.writeUInt8((Math.random() * 256) >>> 0, 8 + i); // transaction id
    socket.send(msg, 0, msg.length, 19302, address, (err) => {
      if (err) {
        clearTimeout(t);
        socket.close();
        console.log(`❌ ${nombre} no se pudo enviar: ${err.message}`);
        resolve(false);
      }
    });
  });
}

// ---------- 2. TCP a un puerto ----------
function probarTCP(nombre, address, puerto, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port: puerto });
    const t = setTimeout(() => {
      socket.destroy();
      console.log(`❌ ${nombre} (${address}:${puerto}) TCP timeout`);
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(t);
      socket.destroy();
      console.log(`✅ ${nombre} (${address}:${puerto}) TCP CONECTA`);
      resolve(true);
    });
    socket.on("error", (e) => {
      clearTimeout(t);
      console.log(`❌ ${nombre} (${address}:${puerto}) TCP error: ${e.message}`);
      resolve(false);
    });
  });
}

// ---------- Pruebas ----------

console.log("========== 1. CONTROL: UDP en general ==========");
await probarUDP("Cloudflare DNS", "1.1.1.1", 53, 4000);
await probarUDP("Google DNS", "8.8.8.8", 53, 4000);

console.log("\n========== 1b. STUN: UDP a puerto alto (19302) ==========");
await probarSTUN("Google STUN", "stun.l.google.com");
await probarSTUN("Cloudflare STUN", "stun.cloudflare.com");

console.log("\n========== 2. Discord: resolución ==========");
let ips;
try {
  ips = await dns.lookup(host, { all: true, verbatim: true });
} catch (e) {
  console.error("❌ No se pudo resolver:", e.message);
  process.exit(1);
}
console.log("IPv4:", ips.filter((i) => i.family === 4).map((i) => i.address).join(", "));
const ipv4 = ips.filter((i) => i.family === 4).map((i) => i.address);
if (!ipv4.length) {
  console.error("❌ Sin IPv4. (Si solo hay IPv6, el NAT/ISP puede no rutearlo).");
}

console.log("\n========== 3. Discord: UDP a varios puertos ==========");
for (const address of ipv4.slice(0, 2)) {
  for (const p of [port, 443, 80]) {
    await probarUDP(`Discord ${address}`, address, p, 4000);
  }
}

console.log("\n========== 4. Discord: TCP a varios puertos ==========");
for (const address of ipv4.slice(0, 2)) {
  await probarTCP(`Discord ${address}`, address, 443);
  await probarTCP(`Discord ${address}`, address, port);
}

console.log("\n========== FIN ==========");
process.exit(0);
