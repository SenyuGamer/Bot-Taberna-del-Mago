// Stub para @snazzah/davey en RISC-V (sin binario nativo).
// DAVE (Discord Audio Video Encryption) no está activo en la mayoría de servidores;
// este stub carga ok y solo falla si Discord realmente negocia DAVE.
const DAVE_PROTOCOL_VERSION = "1";
const DEBUG_BUILD = false;
const VERSION = "0.0.0-stub";

const MediaType = { AUDIO: 0, VIDEO: 1 };
const ProposalsOperationType = {};
const SessionStatus = {};

class DAVESession {
  constructor(..._args) {
    throw new Error(
      "DAVE (Discord Audio Video Encryption) no está soportado en esta plataforma (RISC-V). " +
      "El bot funcionará con cifrado clásico (sodium). Si Discord exige DAVE, actualiza el stub."
    );
  }
}

class DaveSession {
  constructor(..._args) {
    throw new Error(
      "DAVE (Discord Audio Video Encryption) no está soportado en esta plataforma (RISC-V)."
    );
  }
}

function generateDisplayableCode() { return ""; }
function generateKeyFingerprint() { return ""; }
function generateP256Keypair() { return { publicKey: Buffer.alloc(0), privateKey: Buffer.alloc(0) }; }
function generatePairwiseFingerprint() { return ""; }

module.exports = {
  Codec: {},
  DAVE_PROTOCOL_VERSION,
  MediaType,
  ProposalsOperationType,
  SessionStatus,
  DAVESession,
  DaveSession,
  DEBUG_BUILD,
  VERSION,
  generateDisplayableCode,
  generateKeyFingerprint,
  generateP256Keypair,
  generatePairwiseFingerprint,
};
