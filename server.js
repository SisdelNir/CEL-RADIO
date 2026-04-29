const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db');

// ═══ Mediasoup (SFU Media Server) ═══
let mediasoup;
let msConfig;
let mediasoupAvailable = false;
try {
  mediasoup = require('mediasoup');
  msConfig = require('./mediasoup-config');
  mediasoupAvailable = true;
  console.log('[Mediasoup] Módulo cargado correctamente');
} catch (err) {
  console.warn('[Mediasoup] No disponible — usando fallback Socket.io para audio:', err.message);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // Allow large audio buffers if needed (fallback)
});

// ====== VOICE ARBITRATION SERVICE ======
// estado_voz: Map<roomName, { speakerId, speakerName, startedAt, timeout }>
const estado_voz = new Map();
const MAX_SPEAK_TIME = 15000; // 15 segundos máximo de transmisión

function releaseSpeak(room, reason) {
  const state = estado_voz.get(room);
  if (!state) return;
  clearTimeout(state.timeout);
  estado_voz.delete(room);
  // Notificar a todos en la sala que el canal está libre
  io.to(room).emit('SPEAK_RELEASED', { room, speakerName: state.speakerName, reason });
  console.log(`[Arbitraje] Canal ${room} LIBERADO (${reason}) — era ${state.speakerName}`);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve static frontend files

// ================= API ROUTES =================

// ----- EMPRESAS -----
app.get('/api/empresas', (req, res) => {
  db.all('SELECT * FROM empresas', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // Transform to frontend format
    const empresas = rows.map(r => ({
      ...r,
      director: { codigo: r.director_codigo }
    }));
    res.json(empresas);
  });
});

app.post('/api/empresas', (req, res) => {
  const { id, nombre, logo, plan, creado, director } = req.body;
  const sql = `INSERT INTO empresas (id, nombre, logo, plan, creado, director_codigo) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [id, nombre, logo, plan, creado, director.codigo], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, success: true });
  });
});

// ----- USUARIOS -----
app.get('/api/usuarios/:empresaId', (req, res) => {
  db.all('SELECT * FROM usuarios WHERE empresa_id = ?', [req.params.empresaId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/usuarios', (req, res) => {
  const { empresa_id, nombre, identificacion, telefono, rol, codigo, estado, creado } = req.body;
  const sql = `INSERT INTO usuarios (empresa_id, nombre, identificacion, telefono, rol, codigo, estado, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [empresa_id, nombre, identificacion, telefono, rol, codigo, estado, creado], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.put('/api/usuarios/:id', (req, res) => {
  const { nombre, identificacion, telefono, rol, estado } = req.body;
  const sql = `UPDATE usuarios SET nombre = ?, identificacion = ?, telefono = ?, rol = ?, estado = ? WHERE id = ?`;
  db.run(sql, [nombre, identificacion, telefono, rol, estado, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/usuarios/:id', (req, res) => {
  db.run('DELETE FROM usuarios WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ----- CANALES -----
app.get('/api/canales/:empresaId', (req, res) => {
  db.all('SELECT * FROM canales WHERE empresa_id = ?', [req.params.empresaId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/canales', (req, res) => {
  const { empresa_id, nombre, icono, tipo, modo, estado, descripcion } = req.body;
  const sql = `INSERT INTO canales (empresa_id, nombre, icono, tipo, modo, estado, descripcion) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [empresa_id, nombre, icono || '🛣️', tipo || 'grupo', modo || 'ptt', estado || 'activo', descripcion || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.put('/api/canales/:id', (req, res) => {
  const { nombre, icono, tipo, modo, estado, descripcion } = req.body;
  const sql = `UPDATE canales SET nombre = ?, icono = ?, tipo = ?, modo = ?, estado = ?, descripcion = ? WHERE id = ?`;
  db.run(sql, [nombre, icono, tipo, modo, estado, descripcion, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/canales/:id', (req, res) => {
  db.run('DELETE FROM canales WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ═══════════════════════════════════════════════════════════════
// MEDIASOUP SFU — Workers, Routers y Rooms
// ═══════════════════════════════════════════════════════════════

// Estado global de Mediasoup
const msWorkers = [];       // Array de Workers
let msWorkerIndex = 0;      // Round-robin index
const msRooms = new Map();  // Map<roomName, { router, transports, producers, consumers }>

// Inicializar Workers de Mediasoup al arrancar
async function initMediasoup() {
  if (!mediasoupAvailable) {
    console.log('[Mediasoup] Saltando inicialización (módulo no disponible)');
    return;
  }

  const numWorkers = msConfig.numWorkers || 1;
  console.log(`[Mediasoup] Creando ${numWorkers} worker(s)...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: msConfig.worker.logLevel,
      logTags: msConfig.worker.logTags,
      rtcMinPort: msConfig.worker.rtcMinPort,
      rtcMaxPort: msConfig.worker.rtcMaxPort
    });

    worker.on('died', (error) => {
      console.error(`[Mediasoup] Worker #${i} MURIÓ:`, error);
      // En producción: reiniciar el worker
      setTimeout(() => process.exit(1), 2000);
    });

    msWorkers.push(worker);
    console.log(`[Mediasoup] Worker #${i} creado (PID: ${worker.pid})`);
  }
}

// Obtener el siguiente Worker (round-robin)
function getNextWorker() {
  const worker = msWorkers[msWorkerIndex];
  msWorkerIndex = (msWorkerIndex + 1) % msWorkers.length;
  return worker;
}

// Obtener o crear una Room (con su Router)
async function getOrCreateRoom(roomName) {
  if (msRooms.has(roomName)) {
    return msRooms.get(roomName);
  }

  const worker = getNextWorker();
  const router = await worker.createRouter({
    mediaCodecs: msConfig.router.mediaCodecs
  });

  const room = {
    router,
    // Map<peerId (socket.id), { sendTransport, recvTransport }>
    peers: new Map(),
    // Map<producerId, { producer, socketId, senderName, senderInitials }>
    producers: new Map()
  };

  msRooms.set(roomName, room);
  console.log(`[Mediasoup] Room creada: ${roomName}`);
  return room;
}

// Crear un WebRTC Transport
async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    ...msConfig.webRtcTransport,
    enableSctp: false, // Solo audio, no necesitamos datos
    appData: {}
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers: msConfig.iceServers
    }
  };
}

// ================= WEBSOCKETS (SEÑALIZACIÓN EN TIEMPO REAL) =================

io.on('connection', (socket) => {
  console.log(`[Socket] Nuevo cliente conectado: ${socket.id}`);

  // Registro de frecuencia personal del usuario
  socket.on('register_user', (data) => {
    const { empresaId, userId, userName } = data;
    const personalRoom = `empresa_${empresaId}_user_${userId}`;
    socket.join(personalRoom);
    socket.userData = { empresaId, userId, userName };
    // Avisar a todos que este usuario está en línea
    socket.broadcast.emit('user_status_changed', { userId, isOnline: true });
    console.log(`[Socket] ${userName} ONLINE en ${personalRoom}`);
  });

  // Cuando un usuario se une a un canal (Grupo o Privado)
  socket.on('join_channel', (data) => {
    const { channelId, empresaId, userName, tipo } = data;
    
    // FILTRO ANTI-FUSIÓN: Rechazar si faltan datos críticos (evita unirse a "empresa_1_canal_undefined")
    if (!channelId || !empresaId) {
      console.warn(`[Seguridad] Join rechazado por datos inválidos: ${JSON.stringify(data)}`);
      return;
    }

    // SALIR de TODOS los canales de voz anteriores (canal_ y private_)
    const roomsToLeave = [];
    for (const room of socket.rooms) {
      if (room !== socket.id && (room.includes('_canal_') || room.includes('private_'))) {
        roomsToLeave.push(room);
      }
    }
    roomsToLeave.forEach(room => {
      socket.leave(room);
      const prevCount = io.sockets.adapter.rooms.get(room)?.size || 0;
      io.to(room).emit('channel_user_count', { room, count: prevCount });
      console.log(`[Socket] ${userName} SALIÓ de ${room}`);
    });

    const roomName = tipo === 'privado' ? channelId : `empresa_${empresaId}_canal_${channelId}`;
    socket.join(roomName);
    socket.currentVoiceRoom = roomName;
    console.log(`[Socket] ${userName} se unió a ${roomName}`);
    
    const count = io.sockets.adapter.rooms.get(roomName)?.size || 0;
    io.to(roomName).emit('channel_user_count', { room: roomName, count });
  });

  // Orden para forzar (jalar) a un usuario a un canal privado
  socket.on('force_private_call', (data) => {
    const { targetUserId, empresaId, roomName, caller } = data;
    const targetPersonalRoom = `empresa_${empresaId}_user_${targetUserId}`;
    
    // Reenviar la alerta directamente a la frecuencia personal del objetivo
    socket.to(targetPersonalRoom).emit('incoming_private_call', {
      roomName: roomName,
      caller: caller
    });
    console.log(`[Socket] Jalando a usuario ${targetUserId} hacia el cuarto ${roomName}`);
  });

  // Cambiar estado de visibilidad del usuario
  socket.on('toggle_status', (data) => {
    const { empresaId, userId, isOnline } = data;
    // Avisar a todos en la empresa
    socket.broadcast.emit('user_status_changed', { userId, isOnline });
    console.log(`[Socket] Usuario ${userId} cambió su estado a: ${isOnline ? 'Visible' : 'Oculto'}`);
  });

  // Reenviar eventos a un usuario específico (para modo teléfono)
  socket.on('relay_to_user', (data) => {
    const { targetRoom, event, data: eventData } = data;
    // INTEGRIDAD: Solo permitir relay de eventos conocidos (no abrir vector arbitrario)
    const ALLOWED_RELAY_EVENTS = ['open_mic_request', 'open_mic_ended'];
    if (!ALLOWED_RELAY_EVENTS.includes(event)) {
      console.warn(`[Seguridad] Relay de evento no permitido: ${event}`);
      return;
    }
    // Verificar que el targetRoom pertenece a la misma empresa del socket
    const { empresaId } = socket.userData || {};
    if (empresaId && !targetRoom.startsWith(`empresa_${empresaId}_`)) {
      console.warn(`[Seguridad] Relay rechazado: ${targetRoom} no pertenece a empresa ${empresaId}`);
      return;
    }
    socket.to(targetRoom).emit(event, eventData);
    console.log(`[Socket] Relay ${event} → ${targetRoom}`);
  });

  // ====== ARBITRAJE DE VOZ ======
  socket.on('REQUEST_TO_SPEAK', (data) => {
    const { room, userName, userRole } = data;
    
    // DOBLE CHECK: Validar que el usuario *realmente* pertenezca a la sala en Socket.io
    if (!room || !socket.rooms.has(room)) {
      console.warn(`[Seguridad] ${userName} intentó pedir turno en ${room} sin estar unido.`);
      socket.emit('SPEAK_DENIED', { room, occupiedBy: 'Sistema (Acceso Denegado)' });
      return;
    }

    const current = estado_voz.get(room);
    
    if (!current) {
      // Canal libre → conceder turno
      const timeout = setTimeout(() => {
        releaseSpeak(room, 'TIMEOUT');
        socket.emit('SPEAK_TIMEOUT', { room });
      }, MAX_SPEAK_TIME);
      
      estado_voz.set(room, {
        speakerId: socket.id,
        speakerName: userName,
        speakerRole: userRole,
        startedAt: Date.now(),
        timeout
      });
      
      socket.emit('SPEAK_GRANTED', { room });
      socket.to(room).emit('SOMEONE_SPEAKING', { room, speakerName: userName });
      console.log(`[Arbitraje] GRANTED → ${userName} en ${room}`);
    } else if (current.speakerId === socket.id) {
      // Ya tiene el turno, confirmar de nuevo
      socket.emit('SPEAK_GRANTED', { room });
    } else {
      // Canal ocupado
      const elapsed = Math.round((Date.now() - current.startedAt) / 1000);
      socket.emit('SPEAK_DENIED', { room, occupiedBy: current.speakerName, elapsed });
      console.log(`[Arbitraje] DENIED → ${userName} (ocupa ${current.speakerName}, ${elapsed}s)`);
    }
  });
  
  socket.on('RELEASE_SPEAK', (data) => {
    const { room } = data;
    const current = estado_voz.get(room);
    if (current && current.speakerId === socket.id) {
      releaseSpeak(room, 'MANUAL');
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MEDIASOUP SIGNALING (WebRTC SFU)
  // ═══════════════════════════════════════════════════════════════

  if (mediasoupAvailable) {
    // Obtener capacidades del router
    socket.on('ms_getRouterCapabilities', async (callback) => {
      try {
        // Usar las capacidades del config (son las mismas para todos los routers)
        const tempRoom = await getOrCreateRoom('__capabilities__');
        callback(tempRoom.router.rtpCapabilities);
      } catch (err) {
        console.error('[Mediasoup] Error getRouterCapabilities:', err);
        callback({ error: err.message });
      }
    });

    // Unirse a una sala de medios
    socket.on('ms_joinRoom', async (data, callback) => {
      try {
        const { roomName, rtpCapabilities } = data;
        const room = await getOrCreateRoom(roomName);

        // Registrar este peer en la room
        if (!room.peers.has(socket.id)) {
          room.peers.set(socket.id, {
            sendTransport: null,
            recvTransport: null,
            rtpCapabilities
          });
        } else {
          room.peers.get(socket.id).rtpCapabilities = rtpCapabilities;
        }

        socket.msRoom = roomName;

        // Devolver los producers existentes en la sala
        const existingProducers = [];
        for (const [producerId, pData] of room.producers) {
          if (pData.socketId !== socket.id) {
            existingProducers.push({
              producerId: producerId,
              senderName: pData.senderName,
              senderInitials: pData.senderInitials
            });
          }
        }

        console.log(`[Mediasoup] ${socket.id} se unió a room ${roomName}, ${existingProducers.length} producers existentes`);
        callback(existingProducers);
      } catch (err) {
        console.error('[Mediasoup] Error ms_joinRoom:', err);
        callback({ error: err.message });
      }
    });

    // Salir de una sala
    socket.on('ms_leaveRoom', (data) => {
      const { roomName } = data;
      cleanupPeerFromRoom(socket.id, roomName);
    });

    // Crear un WebRTC Transport (send o recv)
    socket.on('ms_createTransport', async (data, callback) => {
      try {
        const { roomName, direction } = data;
        const room = await getOrCreateRoom(roomName);
        const { transport, params } = await createWebRtcTransport(room.router);

        // Guardar referencia en el peer
        const peer = room.peers.get(socket.id);
        if (peer) {
          if (direction === 'send') {
            peer.sendTransport = transport;
          } else {
            peer.recvTransport = transport;
          }
        }

        transport.on('dtlsstatechange', (dtlsState) => {
          if (dtlsState === 'closed') {
            transport.close();
          }
        });

        console.log(`[Mediasoup] Transport ${direction} creado para ${socket.id} en ${roomName}`);
        callback(params);
      } catch (err) {
        console.error('[Mediasoup] Error ms_createTransport:', err);
        callback({ error: err.message });
      }
    });

    // Conectar un Transport (intercambio ICE/DTLS)
    socket.on('ms_connectTransport', async (data, callback) => {
      try {
        const { transportId, dtlsParameters } = data;
        const roomName = socket.msRoom;
        if (!roomName) throw new Error('No estás en una sala');

        const room = msRooms.get(roomName);
        if (!room) throw new Error('Sala no existe');

        const peer = room.peers.get(socket.id);
        if (!peer) throw new Error('Peer no registrado');

        // Buscar el transport correcto
        let transport = null;
        if (peer.sendTransport && peer.sendTransport.id === transportId) {
          transport = peer.sendTransport;
        } else if (peer.recvTransport && peer.recvTransport.id === transportId) {
          transport = peer.recvTransport;
        }

        if (!transport) throw new Error('Transport no encontrado');

        await transport.connect({ dtlsParameters });
        console.log(`[Mediasoup] Transport ${transportId} conectado`);
        callback({});
      } catch (err) {
        console.error('[Mediasoup] Error ms_connectTransport:', err);
        callback({ error: err.message });
      }
    });

    // Producir audio (usuario empieza a transmitir)
    socket.on('ms_produce', async (data, callback) => {
      try {
        const { transportId, roomName, kind, rtpParameters, appData } = data;
        const room = msRooms.get(roomName);
        if (!room) throw new Error('Sala no existe');

        const peer = room.peers.get(socket.id);
        if (!peer || !peer.sendTransport) throw new Error('SendTransport no existe');

        const producer = await peer.sendTransport.produce({
          kind,
          rtpParameters,
          appData
        });

        // Guardar referencia del producer
        room.producers.set(producer.id, {
          producer,
          socketId: socket.id,
          senderName: appData.senderName || 'Desconocido',
          senderInitials: appData.senderInitials || '??'
        });

        producer.on('transportclose', () => {
          room.producers.delete(producer.id);
        });

        // Notificar a TODOS los demás en la sala que hay un nuevo producer
        socket.to(roomName).emit('ms_newProducer', {
          producerId: producer.id,
          senderName: appData.senderName || 'Desconocido',
          senderInitials: appData.senderInitials || '??',
          roomName // Incluir sala para que el cliente filtre correctamente
        });

        console.log(`[Mediasoup] Producer creado: ${producer.id} por ${appData.senderName} en ${roomName}`);
        callback({ producerId: producer.id });
      } catch (err) {
        console.error('[Mediasoup] Error ms_produce:', err);
        callback({ error: err.message });
      }
    });

    // Cerrar un producer (usuario deja de transmitir)
    socket.on('ms_closeProducer', (data) => {
      const { producerId } = data;
      const roomName = socket.msRoom;
      if (!roomName) return;

      const room = msRooms.get(roomName);
      if (!room) return;

      const pData = room.producers.get(producerId);
      if (pData) {
        pData.producer.close();
        const senderName = pData.senderName;
        room.producers.delete(producerId);
        
        // Notificar a todos que este producer se cerró
        socket.to(roomName).emit('ms_producerClosed', { producerId, senderName });
        console.log(`[Mediasoup] Producer cerrado: ${producerId}`);
      }
    });

    // Consumir audio de un producer (usuario quiere escuchar a otro)
    socket.on('ms_consume', async (data, callback) => {
      try {
        const { producerId, roomName, rtpCapabilities } = data;
        const room = msRooms.get(roomName);
        if (!room) throw new Error('Sala no existe');

        const peer = room.peers.get(socket.id);
        if (!peer || !peer.recvTransport) throw new Error('RecvTransport no existe');

        // Verificar que el router puede consumir este producer
        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error('No se puede consumir (codec incompatible)');
        }

        const consumer = await peer.recvTransport.consume({
          producerId,
          rtpCapabilities,
          paused: false // Empezar a recibir inmediatamente
        });

        consumer.on('transportclose', () => {
          console.log(`[Mediasoup] Consumer ${consumer.id} transport cerrado`);
        });

        consumer.on('producerclose', () => {
          console.log(`[Mediasoup] Consumer ${consumer.id} producer cerrado`);
          // Notificar al cliente que este consumer ya no existe
          socket.emit('ms_consumerClosed', { consumerId: consumer.id });
        });

        callback({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        });

        console.log(`[Mediasoup] Consumer creado: ${consumer.id} consume producer ${producerId}`);
      } catch (err) {
        console.error('[Mediasoup] Error ms_consume:', err);
        callback({ error: err.message });
      }
    });

    // Confirmar que el consumer empezó a reproducir
    socket.on('ms_consumerResumed', (data) => {
      // Solo logging por ahora
      console.log(`[Mediasoup] Consumer ${data.consumerId} confirmado por cliente`);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // FALLBACK: Audio por Socket.io (cuando Mediasoup no está disponible)
  // ═══════════════════════════════════════════════════════════════

  // Cuando un usuario transmite voz (FALLBACK — solo si NO hay Mediasoup)
  socket.on('transmit_voice', (data) => {
    if (mediasoupAvailable) return; // Si Mediasoup está activo, ignorar
    const { room, audioBlob, sender, mimeType } = data;
    // INTEGRIDAD DE CANAL: Verificar que el socket está realmente en esa sala
    if (!room || !socket.rooms.has(room)) {
      console.warn(`[Socket] BLOQUEADO: ${sender.name} intentó transmitir a ${room} pero no está en ese canal`);
      return;
    }
    // Retransmitir incluyendo la sala para que el cliente filtre correctamente
    socket.to(room).emit('receive_voice', { audioBlob, sender, mimeType, room });
  });

  socket.on('disconnect', () => {
    // Liberar cualquier canal que este usuario tenga tomado
    for (const [room, state] of estado_voz.entries()) {
      if (state.speakerId === socket.id) {
        releaseSpeak(room, 'DISCONNECT');
      }
    }
    // Avisar a todos que este usuario se desconectó
    if (socket.userData && socket.userData.userId) {
      socket.broadcast.emit('user_status_changed', { userId: socket.userData.userId, isOnline: false });
    }
    // Actualizar conteo en la sala de voz
    if (socket.currentVoiceRoom) {
      const count = io.sockets.adapter.rooms.get(socket.currentVoiceRoom)?.size || 0;
      io.to(socket.currentVoiceRoom).emit('channel_user_count', { room: socket.currentVoiceRoom, count });
    }
    // Limpiar recursos de Mediasoup
    if (mediasoupAvailable && socket.msRoom) {
      cleanupPeerFromRoom(socket.id, socket.msRoom);
    }
    console.log(`[Socket] Cliente desconectado: ${socket.id}`);
  });
});

// ═══ Limpieza de un peer de una room de Mediasoup ═══
function cleanupPeerFromRoom(socketId, roomName) {
  const room = msRooms.get(roomName);
  if (!room) return;

  const peer = room.peers.get(socketId);
  if (!peer) return;

  // Cerrar producers de este peer
  for (const [producerId, pData] of room.producers) {
    if (pData.socketId === socketId) {
      pData.producer.close();
      room.producers.delete(producerId);
      // Notificar a los demás
      io.to(roomName).emit('ms_producerClosed', { producerId, senderName: pData.senderName });
    }
  }

  // Cerrar transports
  if (peer.sendTransport) peer.sendTransport.close();
  if (peer.recvTransport) peer.recvTransport.close();

  room.peers.delete(socketId);

  // Si la room está vacía, eliminarla
  if (room.peers.size === 0) {
    room.router.close();
    msRooms.delete(roomName);
    console.log(`[Mediasoup] Room eliminada (vacía): ${roomName}`);
  }
}

// ================= START =================
const PORT = process.env.PORT || 3000;

async function start() {
  // Inicializar Mediasoup
  await initMediasoup();

  server.listen(PORT, () => {
    console.log(`[Server] Corriendo en http://localhost:${PORT}`);
    if (mediasoupAvailable) {
      console.log(`[Server] Mediasoup SFU ACTIVO — Audio por WebRTC (UDP)`);
    } else {
      console.log(`[Server] Mediasoup NO disponible — Audio por Socket.io (TCP fallback)`);
    }
  });
}

start().catch(err => {
  console.error('[Server] Error al iniciar:', err);
  // Fallback: iniciar sin Mediasoup
  mediasoupAvailable = false;
  server.listen(PORT, () => {
    console.log(`[Server] Corriendo en http://localhost:${PORT} (sin Mediasoup)`);
  });
});
