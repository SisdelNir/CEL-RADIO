const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // Allow large audio buffers if needed
});

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

// ================= WEBSOCKETS (VOZ EN TIEMPO REAL) =================

// Tracking de usuarios por sala { roomName: Map<socketId, userName> }
const roomUsers = {};

// Tracking de bloqueos de canal (Strict Half-Duplex) { roomName: socketId }
const activeLocks = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] Nuevo cliente conectado: ${socket.id}`);

  // Guardar nombre del usuario para tracking
  socket.userName = null;

  // Registro de frecuencia personal del usuario
  socket.on('register_user', (data) => {
    const { empresaId, userId, userName } = data;
    const personalRoom = `empresa_${empresaId}_user_${userId}`;
    socket.join(personalRoom);
    socket.userName = userName;
    console.log(`[Socket] Frecuencia personal asignada: ${userName} en ${personalRoom}`);
  });

  // Cuando un usuario se une a un canal (Grupo o Privado)
  socket.on('join_channel', (data) => {
    const { channelId, empresaId, userName, tipo } = data;
    
    // Remover del tracking de la sala anterior
    for (const room of socket.rooms) {
      if (room !== socket.id && !room.includes('_user_')) {
        if (roomUsers[room]) {
          roomUsers[room].delete(socket.id);
          if (roomUsers[room].size === 0) delete roomUsers[room];
          // Notificar actualización de conteo
          io.to(room).emit('room_user_count', { count: roomUsers[room] ? roomUsers[room].size : 0 });
        }
        socket.leave(room);
      }
    }

    // Si es un canal privado, respetar el nombre exacto. Si es grupo, poner prefijo
    const roomName = tipo === 'privado' ? channelId : `empresa_${empresaId}_canal_${channelId}`;
    socket.join(roomName);
    socket.userName = userName || socket.userName;
    
    // Agregar al tracking de la nueva sala
    if (!roomUsers[roomName]) roomUsers[roomName] = new Map();
    roomUsers[roomName].set(socket.id, socket.userName || 'Piloto');
    
    // Notificar a todos en la sala el nuevo conteo
    io.to(roomName).emit('room_user_count', { count: roomUsers[roomName].size });
    
    console.log(`[Socket] ${userName} se unió a ${roomName} (${roomUsers[roomName].size} usuarios)`);
  });

  // Obtener lista de usuarios en el canal actual
  socket.on('get_channel_users', (data) => {
    const { room } = data;
    const usersInRoom = roomUsers[room] ? Array.from(roomUsers[room].values()) : [];
    socket.emit('channel_users_list', { users: usersInRoom });
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
  // Half-Duplex: Bloqueo de Canal (Candado Fuerte)
  socket.on('lock_channel', (data, callback) => {
    const { room, user } = data;
    
    // Si la sala ya está bloqueada por otro usuario, rechazar
    if (activeLocks.has(room) && activeLocks.get(room) !== socket.id) {
      console.log(`[Socket] Bloqueo denegado a ${user} en ${room} (en uso)`);
      if (typeof callback === 'function') callback({ success: false });
      return;
    }
    
    // Adquirir el candado
    activeLocks.set(room, socket.id);
    socket.to(room).emit('channel_locked', { user });
    console.log(`[Socket] Canal bloqueado en ${room} por ${user}`);
    if (typeof callback === 'function') callback({ success: true });
  });

  // Half-Duplex: Desbloqueo de Canal
  socket.on('unlock_channel', (data) => {
    const { room } = data;
    // Solo liberar si el que lo pide es el dueño actual
    if (activeLocks.get(room) === socket.id) {
      activeLocks.delete(room);
      socket.to(room).emit('channel_unlocked');
      console.log(`[Socket] Canal liberado en ${room}`);
    }
  });

  // Cuando un usuario transmite voz
  socket.on('transmit_voice', (data) => {
    const { room, audioBlob, sender, mimeType } = data;
    // Retransmitir el audio a todos los demás en el canal
    socket.to(room).emit('receive_voice', { audioBlob, sender, mimeType });
  });

  socket.on('disconnect', () => {
    // Limpiar tracking de salas
    for (const room in roomUsers) {
      if (roomUsers[room].has(socket.id)) {
        roomUsers[room].delete(socket.id);
        if (roomUsers[room].size === 0) {
          delete roomUsers[room];
        } else {
          io.to(room).emit('room_user_count', { count: roomUsers[room].size });
        }
      }
    }
    
    // Limpiar bloqueos activos (si este usuario se desconecta hablando)
    for (const [room, ownerId] of activeLocks.entries()) {
      if (ownerId === socket.id) {
        activeLocks.delete(room);
        socket.to(room).emit('channel_unlocked');
        console.log(`[Socket] Canal ${room} liberado por desconexión`);
      }
    }
    
    console.log(`[Socket] Cliente desconectado: ${socket.id}`);
  });
});

// ================= START =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Corriendo en http://localhost:${PORT}`);
});
