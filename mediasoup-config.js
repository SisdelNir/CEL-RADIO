// ═══════════════════════════════════════════════════════════════
// CEL-RADIO — Configuración de Mediasoup (SFU Media Server)
// ═══════════════════════════════════════════════════════════════
const os = require('os');

module.exports = {
  // ── Workers ──
  // Un worker por núcleo de CPU (mínimo 1)
  numWorkers: Math.max(1, os.cpus().length),

  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  },

  // ── Router ──
  // Codecs soportados (OPUS es el estándar para voz PTT)
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2, // OPUS REQUIRES 2 channels for Mediasoup/WebRTC SDP standard
        parameters: {
          'sprop-stereo': 0,
          'useinbandfec': 1,  // Forward Error Correction (recupera paquetes perdidos)
          'usedtx': 1         // Detección de silencio (ahorra ancho de banda)
        }
      }
    ]
  },

  // ── WebRTC Transport ──
  webRtcTransport: {
    listenIps: [
      {
        // IP de escucha del servidor
        ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        // IP pública anunciada (IMPORTANTE para producción)
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null
      }
    ],
    // Habilitar UDP y TCP como fallback
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // Timeouts de ICE
    initialAvailableOutgoingBitrate: 600000, // 600kbps inicial (suficiente para voz)
    maxIncomingBitrate: 1500000 // 1.5Mbps máximo
  },

  // ── TURN/STUN Servers (para clientes detrás de NAT/Firewall) ──
  // Estos se envían al cliente para establecer la conexión WebRTC
  iceServers: [
    // STUN gratuito de Google (solo descubrimiento de IP pública)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN server (configurar con Coturn o servicio como metered.ca)
    ...(process.env.TURN_SERVER ? [{
      urls: process.env.TURN_SERVER,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || ''
    }] : [])
  ]
};
