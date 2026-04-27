const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Render persistent disk or local fallback
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'cel_radio.sqlite');
console.log(`[DB] Conectando a SQLite en: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[DB] Error conectando a la base de datos:', err.message);
  } else {
    console.log('[DB] Conectado exitosamente a SQLite.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    // Tabla Empresas (Tenants)
    db.run(`CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      logo TEXT,
      plan TEXT DEFAULT 'premium',
      creado TEXT,
      director_codigo TEXT NOT NULL
    )`);

    // Tabla Usuarios (Pilotos/Directores)
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      nombre TEXT NOT NULL,
      identificacion TEXT,
      telefono TEXT,
      rol TEXT NOT NULL,
      codigo TEXT NOT NULL,
      estado TEXT DEFAULT 'en_linea',
      creado TEXT,
      FOREIGN KEY(empresa_id) REFERENCES empresas(id)
    )`);

    // Tabla Canales
    db.run(`CREATE TABLE IF NOT EXISTS canales (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nombre TEXT NOT NULL,
      icono TEXT,
      tipo TEXT DEFAULT 'grupo',
      modo TEXT DEFAULT 'ptt',
      FOREIGN KEY(empresa_id) REFERENCES empresas(id)
    )`);
  });
}

module.exports = db;
