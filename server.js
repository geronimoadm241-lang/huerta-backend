require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Tablas que usa el sistema de reclamos (clientes y facturas quedan como historial de la app anterior)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS pdfs_banco (tipo TEXT PRIMARY KEY, nombre TEXT, url TEXT, public_id TEXT);
    CREATE TABLE IF NOT EXISTS clientes (empresa TEXT PRIMARY KEY, contacto TEXT DEFAULT '', email TEXT DEFAULT '', sede TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS facturas (
      id TEXT PRIMARY KEY, empresa TEXT, contacto TEXT DEFAULT '', email TEXT DEFAULT '', valor NUMERIC DEFAULT 0,
      moneda TEXT DEFAULT 'ARS', fecha TEXT, tipo TEXT DEFAULT 'A', referencia TEXT, pdf TEXT DEFAULT '', pdf_url TEXT DEFAULT '',
      sede TEXT DEFAULT '', sent BOOLEAN DEFAULT FALSE, lista BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());
  `);
  console.log('DB initialized');
}

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Huerta Coworking - Reclamos' }));

require('./reclamos')(app, pool);

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Huerta backend running on port ${PORT}`));
}).catch(console.error);
