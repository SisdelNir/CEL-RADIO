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
    // Transform to match old frontend
    const canales = rows.map(r => ({
      id: r.id, name: r.nombre, icon: r.icono, type: r.tipo, mode: r.modo, users: 0 // Users managed by sockets
    }));
    res.json(canales);
  });
});

app.post('/api/canales', (req, res) => {
  const { id, empresa_id, name, icon, type, mode } = req.body;
  const sql = `INSERT INTO canales (id, empresa_id, nombre, icono, tipo, modo) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [id, empresa_id, name, icon, type, mode], function(err) {
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

  // Cuando un usuario se une a un canal
  socket.on('join_channel', (data) => {
    const { channelId, empresaId, userName } = data;
    
    // Si estaba en otro canal, salir
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }

    const roomName = `empresa_${empresaId}_canal_${channelId}`;
    socket.join(roomName);
    console.log(`[Socket] ${userName} se unió a ${roomName}`);
  });

  // Cuando un usuario transmite voz
  socket.on('transmit_voice', (data) => {
    const { room, audioBlob, sender } = data;
    // Retransmitir el audio a todos los demás en el canal
    socket.to(room).emit('receive_voice', { audioBlob, sender });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Cliente desconectado: ${socket.id}`);
  });
});

// ================= START =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Corriendo en http://localhost:${PORT}`);
});
