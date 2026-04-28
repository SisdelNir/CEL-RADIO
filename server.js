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

io.on('connection', (socket) => {
  console.log(`[Socket] Nuevo cliente conectado: ${socket.id}`);

  // Registro de frecuencia personal del usuario
  socket.on('register_user', (data) => {
    const { empresaId, userId, userName } = data;
    const personalRoom = `empresa_${empresaId}_user_${userId}`;
    socket.join(personalRoom);
    socket.userData = { empresaId, userId, userName };
    console.log(`[Socket] Frecuencia personal asignada: ${userName} en ${personalRoom}`);
  });

  // Cuando un usuario se une a un canal (Grupo o Privado)
  socket.on('join_channel', (data) => {
    const { channelId, empresaId, userName, tipo } = data;
    
    // Si estaba en otro canal, salir y actualizar conteo
    for (const room of socket.rooms) {
      if (room !== socket.id && !room.includes('_user_')) {
        socket.leave(room);
        const prevCount = io.sockets.adapter.rooms.get(room)?.size || 0;
        io.to(room).emit('channel_user_count', { room, count: prevCount });
      }
    }

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

  // Cuando un usuario transmite voz (micro-chunks en tiempo real)
  socket.on('transmit_voice', (data) => {
    const { room, audioBlob, sender, mimeType } = data;
    // Retransmitir el audio a todos los demás en el canal
    socket.to(room).emit('receive_voice', { audioBlob, sender, mimeType });
  });

  socket.on('disconnect', () => {
    // Actualizar conteo en la sala de voz
    if (socket.currentVoiceRoom) {
      const count = io.sockets.adapter.rooms.get(socket.currentVoiceRoom)?.size || 0;
      io.to(socket.currentVoiceRoom).emit('channel_user_count', { room: socket.currentVoiceRoom, count });
    }
    console.log(`[Socket] Cliente desconectado: ${socket.id}`);
  });
});

// ================= START =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Corriendo en http://localhost:${PORT}`);
});
