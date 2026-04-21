require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── CLOUDINARY ──
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── POSTGRES ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── GMAIL OAUTH ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

// ── MULTER (memory) ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ══════════════════════════════════════
// DB INIT
// ══════════════════════════════════════
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      empresa TEXT PRIMARY KEY,
      contacto TEXT DEFAULT '',
      email TEXT DEFAULT '',
      sede TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS facturas (
      id TEXT PRIMARY KEY,
      empresa TEXT,
      contacto TEXT DEFAULT '',
      email TEXT DEFAULT '',
      valor NUMERIC DEFAULT 0,
      moneda TEXT DEFAULT 'ARS',
      fecha TEXT,
      tipo TEXT DEFAULT 'A',
      referencia TEXT,
      pdf TEXT DEFAULT '',
      pdf_url TEXT DEFAULT '',
      sede TEXT DEFAULT '',
      sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pdfs_banco (
      tipo TEXT PRIMARY KEY,
      nombre TEXT,
      url TEXT,
      public_id TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  console.log('DB initialized');
}

// ══════════════════════════════════════
// HEALTH
// ══════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'ok', app: 'Huerta Coworking Backend' }));

// ══════════════════════════════════════
// CLIENTES
// ══════════════════════════════════════
app.get('/api/clientes', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clientes ORDER BY empresa');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/clientes', async (req, res) => {
  try {
    const { empresa, contacto, email, sede } = req.body;
    await pool.query(`
      INSERT INTO clientes (empresa, contacto, email, sede)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (empresa) DO UPDATE SET contacto=$2, email=$3, sede=$4
    `, [empresa, contacto||'', email||'', sede||'']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/clientes/bulk', async (req, res) => {
  try {
    const clientes = req.body;
    for (const c of clientes) {
      await pool.query(`
        INSERT INTO clientes (empresa, contacto, email, sede)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (empresa) DO UPDATE SET contacto=$2, email=$3, sede=$4
      `, [c.empresa, c.contacto||'', c.email||'', c.sede||'']);
    }
    res.json({ ok: true, count: clientes.length });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ══════════════════════════════════════
// FACTURAS
// ══════════════════════════════════════
app.get('/api/facturas', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM facturas ORDER BY fecha ASC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/facturas/bulk', async (req, res) => {
  try {
    const facturas = req.body;
    for (const f of facturas) {
      await pool.query(`
        INSERT INTO facturas (id, empresa, contacto, email, valor, moneda, fecha, tipo, referencia, pdf, sede, sent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO NOTHING
      `, [f.id, f.empresa, f.contacto||'', f.email||'', f.valor||0, f.moneda||'ARS', f.fecha, f.tipo||'A', f.referencia||'', f.pdf||'', f.sede||'', f.sent||false]);
    }
    res.json({ ok: true, count: facturas.length });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.patch('/api/facturas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i+2}`).join(',');
    const vals = Object.values(fields);
    await pool.query(`UPDATE facturas SET ${sets} WHERE id=$1`, [id, ...vals]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.delete('/api/facturas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM facturas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// Mark empresa as sent
app.post('/api/facturas/marcar-enviado', async (req, res) => {
  try {
    const { empresa, sent } = req.body;
    const sentValue = sent === false ? false : true;
    await pool.query('UPDATE facturas SET sent=$1 WHERE empresa=$2', [sentValue, empresa]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ══════════════════════════════════════
// PDFs — upload to Cloudinary
// ══════════════════════════════════════
app.post('/api/pdfs/banco', upload.single('file'), async (req, res) => {
  try {
    const { tipo } = req.body; // 'cbu' or 'merc'
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    // Upload to Cloudinary as raw file
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'raw', folder: 'huerta-banco', public_id: `banco-${tipo}`, overwrite: true },
        (err, res) => err ? reject(err) : resolve(res)
      ).end(fileBuffer);
    });

    // Save in DB
    await pool.query(`
      INSERT INTO pdfs_banco (tipo, nombre, url, public_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tipo) DO UPDATE SET nombre=$2, url=$3, public_id=$4
    `, [tipo, fileName, result.secure_url, result.public_id]);

    res.json({ ok: true, url: result.secure_url, nombre: fileName });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/pdfs/banco', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM pdfs_banco');
    const out = {};
    r.rows.forEach(row => out[row.tipo] = { url: row.url, nombre: row.nombre });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/pdfs/factura', upload.single('file'), async (req, res) => {
  try {
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    const publicId = fileName.replace('.pdf', '');

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'raw', folder: 'huerta-facturas', public_id: publicId, overwrite: true },
        (err, res) => err ? reject(err) : resolve(res)
      ).end(fileBuffer);
    });

    // Update factura with pdf_url - match by referencia or pdf filename
    await pool.query(
      `UPDATE facturas SET pdf_url=$1 WHERE referencia=$2 OR pdf=$3 OR pdf=$4`,
      [result.secure_url, publicId, fileName, publicId]
    );

    res.json({ ok: true, url: result.secure_url, nombre: fileName });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ══════════════════════════════════════
// GMAIL OAUTH
// ══════════════════════════════════════
app.get('/api/gmail/auth-url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.send'],
    prompt: 'consent',
  });
  res.json({ url });
});

app.post('/api/gmail/callback', async (req, res) => {
  try {
    const { code } = req.body;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // Save tokens in DB
    await pool.query(`
      INSERT INTO config (key, value) VALUES ('gmail_tokens', $1)
      ON CONFLICT (key) DO UPDATE SET value=$1
    `, [JSON.stringify(tokens)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

async function getGmailTransport() {
  const r = await pool.query(`SELECT value FROM config WHERE key='gmail_tokens'`);
  if (!r.rows.length) throw new Error('Gmail no autorizado');
  const tokens = JSON.parse(r.rows[0].value);
  oauth2Client.setCredentials(tokens);
  // Refresh if expired
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await pool.query(`UPDATE config SET value=$1 WHERE key='gmail_tokens'`, [JSON.stringify(credentials)]);
    oauth2Client.setCredentials(credentials);
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.GMAIL_FROM,
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: oauth2Client.credentials.refresh_token,
      accessToken: oauth2Client.credentials.access_token,
    },
  });
}

// ══════════════════════════════════════
// SEND EMAIL
// ══════════════════════════════════════
// Email send endpoint - uses gmailToken from frontend OAuth implicit flow
app.post('/api/email/send', async (req, res) => {
  try {
    const { to, toName, cc, subject, html, attachments, gmailToken } = req.body;

    console.log('Send request:', { to, toName, cc: cc?.length, attachments: attachments?.length, hasToken: !!gmailToken });

    if (!gmailToken) {
      return res.status(401).json({ error: 'Gmail token required. Please authorize Gmail in the app.' });
    }

    // Build MIME email with attachments manually and send via Gmail REST API
    // This avoids nodemailer OAuth2 token refresh issues (nodemailer tries to refresh
    // the token internally even when you provide an access token directly)

    const boundary = 'boundary_huerta_' + Date.now();
    const fromName = process.env.GMAIL_FROM_NAME || 'Huerta Coworking';
    const fromEmail = process.env.GMAIL_FROM;
    const ccList = (cc || []).filter(Boolean);

    // Process attachments
    const attParts = [];
    for (const att of (attachments || [])) {
      const src = att.content || att.url;
      if (!src) continue;

      let b64data, contentType;

      if (src.startsWith('data:')) {
        const matches = src.match(/^data:([^;]+);base64,(.+)$/s);
        if (matches) {
          contentType = matches[1];
          b64data = matches[2].replace(/\s/g, '');
          console.log('Attachment (base64):', att.filename, 'size:', b64data.length);
        }
      } else {
        // Download from URL (Cloudinary etc)
        console.log('Downloading attachment:', att.filename, src.substring(0, 80));
        try {
          const fetch = require('node-fetch');
          const r = await fetch(src);
          if (!r.ok) throw new Error('Download failed: ' + r.status);
          const buf = await r.buffer();
          b64data = buf.toString('base64');
          contentType = r.headers.get('content-type') || 'application/pdf';
          console.log('Downloaded:', att.filename, 'size:', b64data.length);
        } catch(downloadErr) {
          console.warn('Failed to download attachment:', att.filename, downloadErr.message);
          continue;
        }
      }

      if (b64data) {
        attParts.push({ filename: att.filename, contentType, b64data });
      }
    }

    console.log('Total attachments:', attParts.length);

    // Build multipart MIME message
    const htmlBase64 = Buffer.from(html, 'utf8').toString('base64');

    let mimeLines = [
      `From: ${fromName} <${fromEmail}>`,
      `To: ${toName} <${to}>`,
      ccList.length > 0 ? `Cc: ${ccList.join(', ')}` : null,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      htmlBase64,
    ].filter(l => l !== null);

    for (const att of attParts) {
      mimeLines.push(
        `--${boundary}`,
        `Content-Type: ${att.contentType}; name="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        ``,
        att.b64data
      );
    }

    mimeLines.push(`--${boundary}--`);

    const rawEmail = mimeLines.join('\r\n');
    const encoded = Buffer.from(rawEmail).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    // Send via Gmail REST API using the access token directly
    const fetch = require('node-fetch');
    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gmailToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encoded }),
    });

    const gmailData = await gmailRes.json();

    if (!gmailRes.ok) {
      console.error('Gmail API error:', gmailData);
      if (gmailRes.status === 401) {
        return res.status(401).json({ error: 'Gmail token expired or invalid' });
      }
      return res.status(500).json({ error: gmailData.error?.message || 'Gmail API error' });
    }

    console.log('Email sent via Gmail API:', gmailData.id);
    res.json({ ok: true, messageId: gmailData.id });

  } catch (e) {
    console.error('Send error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});


// Borrar todas las facturas
app.post('/api/facturas/borrar-todo', async (req, res) => {
  try {
    await pool.query('DELETE FROM facturas');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// ══════════════════════════════════════
// START
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Huerta backend running on port ${PORT}`));
}).catch(console.error);
