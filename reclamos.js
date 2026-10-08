// Reclamos automáticos: lee facturas pendientes de Colppy, arma un mail por cliente
// y lo envía por Gmail con refresh token (no hace falta renovar el token a mano).
const crypto = require('crypto');
const { google } = require('googleapis');

// ---------- Configuración ----------
const BACKEND_URL = (process.env.BACKEND_URL || 'https://huerta-backend.onrender.com').replace(/\/$/, '');
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const COLPPY_URL = process.env.COLPPY_URL || 'https://login.colppy.com/lib/frontera2/service.php';
const COLPPY_PDF_URL = 'https://login.colppy.com/resources/Provisiones/ColppyCommon/GenerarFactura.php';
const COLPPY_USER = process.env.COLPPY_USER || 'admin@huertacoworking.com';
const COLPPY_ID_EMPRESA = process.env.COLPPY_ID_EMPRESA || '82543';
const GMAIL_REDIRECT = process.env.GMAIL_SERVER_REDIRECT_URI || `${BACKEND_URL}/api/gmail/oauth2callback`;
const FROM_NAME = process.env.GMAIL_FROM_NAME || 'Huerta Coworking';
const TZ = 'America/Argentina/Buenos_Aires';

const CC_FIJOS = ['juan@huertacoworking.com', 'agustin@huertacoworking.com'];
const SEDES = [
  { sede: 'Humboldt', cc: 'solange@huertacoworking.com', pv: ['0019', '0021', '0014', '0018', '0024', '0022', '0027'] },
  { sede: 'Microcentro', cc: 'rocio@huertacoworking.com', pv: ['0012', '0013', '0017', '0015', '0026'] },
  { sede: 'Dorrego', cc: 'melisa@huertacoworking.com', pv: ['0008', '0020', '0016', '0011'] },
  { sede: 'H2', cc: 'solange@huertacoworking.com', pv: ['0028'] },
  { sede: 'P. Retiro', cc: 'rocio@huertacoworking.com', pv: ['0023', '0029', '0030'] },
  { sede: '25 de Mayo', cc: 'rocio@huertacoworking.com', pv: ['0031'] },
];
const sedeDePV = pv => SEDES.find(s => s.pv.includes(pv)) || null;

const LETRAS = { '0': 'A', '1': 'B', '5': 'I', '6': 'M', '7': 'X', '8': 'T' };
const SIEMPRE_USD = ['T', 'I', 'M'];
const DIA_VENCIMIENTO = 10;
// Vence el día 10 del mes de emisión (o del mes siguiente si se emitió después del 10)
function vencimientoDia10(emision, fechaColppy) {
  const [y, m, d] = emision.split('-').map(Number);
  let vy = y, vm = m;
  if (d > DIA_VENCIMIENTO) { vm++; if (vm > 12) { vm = 1; vy++; } }
  const v = `${vy}-${String(vm).padStart(2, '0')}-${String(DIA_VENCIMIENTO).padStart(2, '0')}`;
  return fechaColppy && fechaColppy > v ? fechaColppy : v;
}
const DIAS_MORA = 90;
const TASA_FALLBACK = 2; // % mensual si falta el IPC de un mes
const HORAS_BLOQUEO_REENVIO = 20; // no se reenvía al mismo cliente dentro de este plazo
const MAX_MAILS_POR_LOTE = 200;
const LOTE_VALIDO_HORAS = 6;

const TIPOS = {
  recordatorio: { label: 'Recordatorio día 8', asunto: () => 'Recordatorio de vencimiento · Huerta Coworking' },
  reclamo1: { label: 'Reclamo día 15', asunto: () => 'Factura pendiente de pago · Huerta Coworking' },
  reclamo2: { label: 'Segundo aviso día 20', asunto: () => 'Segundo aviso · Factura pendiente · Huerta Coworking' },
  mora: { label: 'Mora +90 días', asunto: emp => `URGENTE: Deuda en mora · ${emp} · Cuenta en revisión` },
};

// ---------- Utilidades ----------
const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round(n * 100) / 100;
const fmt = (n, moneda) => moneda === 'USD'
  ? 'USD ' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaAR = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const limpiarEmails = s => [...new Set(String(s || '').split(/[;,\s]+/).map(e => e.trim().toLowerCase()).filter(e => EMAIL_RE.test(e)))];
const claveEmpresa = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function parseUSD(desc) {
  const t = String(desc || '');
  const m = t.match(/(\d[\d.,]*)\s*(?:usd|u\$s|us\$|d[oó]lares)/i) || t.match(/(?:usd|u\$s|us\$)\s*(\d[\d.,]*)/i);
  if (!m) return null;
  let s = m[1].replace(/[.,]$/, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}

// ---------- Colppy ----------
let colppySesion = null, colppySesionTs = 0;

async function colppyRaw(provision, operacion, parameters) {
  const r = await fetch(COLPPY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: { usuario: COLPPY_USER, password: md5(process.env.COLPPY_PASS || '') },
      service: { provision, operacion },
      parameters,
    }),
  });
  return r.json();
}
const colppyFallo = r => (r?.result?.estado ?? 0) !== 0 || r?.response?.success === false;

async function colppyGetSesion(force = false) {
  if (colppySesion && !force && Date.now() - colppySesionTs < 8 * 3600e3) return colppySesion;
  if (!process.env.COLPPY_PASS) throw new Error('Falta la variable COLPPY_PASS en Render');
  const r = await colppyRaw('Usuario', 'iniciar_sesion', { usuario: COLPPY_USER, password: md5(process.env.COLPPY_PASS) });
  const d = r?.response?.data;
  if (!d?.claveSesion) throw new Error('No se pudo iniciar sesión en Colppy: ' + JSON.stringify(r?.result || r).slice(0, 200));
  colppySesion = { usuario: COLPPY_USER, claveSesion: d.claveSesion };
  colppySesionTs = Date.now();
  return colppySesion;
}

async function colppy(provision, operacion, params = {}) {
  const build = async force => ({ sesion: await colppyGetSesion(force), idEmpresa: COLPPY_ID_EMPRESA, ...params });
  let r = await colppyRaw(provision, operacion, await build(false));
  if (colppyFallo(r) && /sesi/i.test(JSON.stringify(r?.result || '') + (r?.response?.message || ''))) {
    r = await colppyRaw(provision, operacion, await build(true));
  }
  if (colppyFallo(r)) throw new Error(`Colppy ${provision}/${operacion}: ${r?.response?.message || r?.result?.mensaje || 'error'}`);
  return r.response.data;
}

async function colppyFacturasPendientes() {
  const out = [];
  for (let start = 0; ; start += 1000) {
    const data = await colppy('FacturaVenta', 'listar_facturasventa', {
      filter: [
        { field: 'idEstadoFactura', op: '=', value: '3' }, // 3 = pendiente de cobro
        { field: 'idTipoComprobante', op: '=', value: '4' }, // 4 = factura (excluye notas de crédito)
        { field: 'fechaFactura', op: '<=', value: hoyAR() }, // excluye facturas emitidas a futuro
      ],
      order: { field: ['fechaFactura'], order: 'asc' },
      start, limit: 1000,
    });
    const arr = Array.isArray(data) ? data : [];
    out.push(...arr);
    if (arr.length < 1000) break;
  }
  return out;
}

async function colppyEmailCliente(idCliente) {
  try {
    const d = await colppy('Cliente', 'leer_cliente', { idCliente: String(idCliente) });
    return limpiarEmails(d?.Email);
  } catch { return []; }
}

let ultimoErrorPdf = '', ultimoOrigenPdf = '';
async function colppyPdfFactura(idFactura, idCliente) {
  ultimoErrorPdf = ''; ultimoOrigenPdf = '';
  for (const force of [false, true]) {
    const s = await colppyGetSesion(force);
    const q = new URLSearchParams({ usuario: s.usuario, claveSesion: s.claveSesion, idEmpresa: COLPPY_ID_EMPRESA, idFactura: String(idFactura), idCliente: String(idCliente) });
    try {
      const r = await fetch(`${COLPPY_PDF_URL}?${q}`, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'application/pdf,text/html;q=0.9,*/*;q=0.8',
        },
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const inicio = buf.subarray(0, 4096).indexOf('%PDF');
      if (r.ok && inicio >= 0) { ultimoOrigenPdf = 'electronica'; return inicio ? buf.subarray(inicio) : buf; }
      if (/no es electr/i.test(buf.toString('utf8'))) {
        try { return await colppyPdfNoElectronica(idFactura, idCliente); }
        catch (e) { ultimoErrorPdf = 'Factura no electrónica y no se pudo generar el PDF: ' + e.message; return null; }
      }
      ultimoErrorPdf = `HTTP ${r.status}, tipo ${r.headers.get('content-type') || '?'}, ${buf.length} bytes: ` +
        buf.subarray(0, 160).toString('utf8').replace(/\s+/g, ' ').trim();
      console.warn('PDF Colppy falló', idFactura, ultimoErrorPdf);
    } catch (e) {
      ultimoErrorPdf = 'Error de red: ' + e.message;
      console.warn('PDF Colppy error', idFactura, e.message);
    }
  }
  return null;
}

// ---------- PDF propio para facturas no electrónicas ----------
function pdfDesdeDatos(info, items, cliente) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const partes = [];
    doc.on('data', b => partes.push(b));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const W = doc.page.width - 96, X = 48;
    const n = v => (+v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const letra = String(info.idTipoFactura || '').length === 1 ? info.idTipoFactura : '';
    const usd = parseUSD(info.descripcion);

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text('HUERTA', X, 50);
    doc.font('Helvetica').fontSize(9).fillColor('#666').text('COWORKING', X, 73);
    if (letra) {
      doc.rect(X + W / 2 - 22, 46, 44, 44).lineWidth(1).stroke('#111');
      doc.font('Helvetica-Bold').fontSize(26).fillColor('#111').text(letra, X + W / 2 - 22, 55, { width: 44, align: 'center' });
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text('Factura', X + W / 2 + 40, 48, { width: W / 2 - 40, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#333')
      .text(`N° ${info.nroFactura}`, X + W / 2 + 40, 70, { width: W / 2 - 40, align: 'right' })
      .text(`Fecha: ${String(info.fechaFactura).replace(/-/g, '/')}`, { width: W / 2 - 40, align: 'right' })
      .text(`Vencimiento: ${String(info.fechaPago).replace(/-/g, '/')}`, { width: W / 2 - 40, align: 'right' });
    doc.moveTo(X, 118).lineTo(X + W, 118).lineWidth(0.5).stroke('#999');

    // Cliente
    let y = 132;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('CLIENTE', X, y);
    y += 14;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(cliente.RazonSocial || '', X, y, { width: W });
    y = doc.y + 2;
    const dir = [cliente.DirFiscal || cliente.DirPostal, cliente.DirFiscalCiudad || cliente.DirPostalCiudad].filter(Boolean).join(', ');
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    if (cliente.CUIT) { doc.text(`CUIT: ${cliente.CUIT}`, X, y); y = doc.y; }
    if (dir) { doc.text(dir, X, y, { width: W }); y = doc.y; }
    doc.text(`Condición de pago: ${info.idCondicionPago || '-'}`, X, y);
    y = doc.y + 18;

    // Ítems
    const cols = [{ t: 'Descripción', w: W * 0.52, a: 'left' }, { t: 'Cant.', w: W * 0.1, a: 'right' },
      { t: 'Precio unit.', w: W * 0.19, a: 'right' }, { t: 'Importe', w: W * 0.19, a: 'right' }];
    doc.rect(X, y, W, 20).fill('#F1EEE8');
    let cx = X;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#333');
    for (const c of cols) { doc.text(c.t, cx + 6, y + 6, { width: c.w - 12, align: c.a }); cx += c.w; }
    y += 26;
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    for (const it of items) {
      const cant = +it.Cantidad || 0, pu = +it.ImporteUnitario || 0;
      const vals = [it.Descripcion + (it.Comentario ? `\n${it.Comentario}` : ''), String(+cant.toFixed(2)), n(pu), n(cant * pu * (1 - (+it.porcDesc || 0) / 100))];
      const h = Math.max(...vals.map((v, i) => doc.heightOfString(v, { width: cols[i].w - 12 })));
      cx = X;
      vals.forEach((v, i) => { doc.text(v, cx + 6, y, { width: cols[i].w - 12, align: cols[i].a }); cx += cols[i].w; });
      y += h + 10;
      doc.moveTo(X, y - 5).lineTo(X + W, y - 5).lineWidth(0.3).stroke('#ccc');
    }

    // Totales
    y += 8;
    const fila = (label, valor, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111');
      doc.text(label, X + W * 0.5, y, { width: W * 0.3, align: 'right' });
      doc.text(valor, X + W * 0.8, y, { width: W * 0.2, align: 'right' });
      y += bold ? 20 : 16;
    };
    if (+info.netoGravado) fila('Neto gravado', '$ ' + n(info.netoGravado));
    if (+info.netoNoGravado) fila('No gravado', '$ ' + n(info.netoNoGravado));
    if (+info.totalIVA) fila('IVA', '$ ' + n(info.totalIVA));
    fila('Total', '$ ' + n(info.totalFactura), true);
    if (usd) fila('Total en dólares', 'USD ' + n(usd), true);

    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text('Huerta Coworking', X, doc.page.height - 70, { width: W, align: 'center' });
    doc.end();
  });
}

const COLPPY_ADJ_URL = 'https://login.colppy.com/resources/Provisiones/ColppyCommon/common/FileManagement/DownloadArchivoComprobante.php';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': 'application/pdf,*/*;q=0.8' };

// Baja el PDF adjunto a la factura en Colppy (el que se ve en "Archivos")
async function colppyAdjunto(f) {
  const info = f.infofactura || {};
  if (!f.archivoId || !f.nombreArchivo) return { detalle: 'la factura no tiene archivo adjunto en Colppy' };
  let detalle = '';
  for (const force of [false, true]) {
    const s = await colppyGetSesion(force);
    const q = new URLSearchParams({
      idEmpresa: COLPPY_ID_EMPRESA, idUsuario: s.usuario, tipoComprobante: 'FAV',
      idComprobante: String(info.idFactura), nombreArchivo: f.nombreArchivo, idArchivo: String(f.archivoId),
      usuario: s.usuario, claveSesion: s.claveSesion,
    });
    try {
      const r = await fetch(`${COLPPY_ADJ_URL}?${q}`, { redirect: 'follow', headers: UA });
      const buf = Buffer.from(await r.arrayBuffer());
      const ini = buf.subarray(0, 4096).indexOf('%PDF');
      if (r.ok && ini >= 0) return { buf: ini ? buf.subarray(ini) : buf };
      detalle = `adjunto: HTTP ${r.status}, ${r.headers.get('content-type') || '?'}, ${buf.length} bytes: ` +
        buf.subarray(0, 160).toString('utf8').replace(/\s+/g, ' ').trim();
    } catch (e) { detalle = 'adjunto: error de red ' + e.message; }
  }
  console.warn('Adjunto Colppy falló', info.nroFactura, detalle);
  return { detalle };
}

// Facturas no electrónicas: primero el adjunto original, si no, PDF generado con los datos de Colppy
async function colppyPdfNoElectronica(idFactura, idCliente) {
  const f = await colppyRaw2('FacturaVenta', 'leer_facturaventa', { idFactura: String(idFactura) });
  if (!f?.infofactura) throw new Error('Colppy no devolvió los datos de la factura');
  const adj = await colppyAdjunto(f);
  if (adj.buf) { ultimoOrigenPdf = 'adjunto'; return adj.buf; }
  const cliente = await colppy('Cliente', 'leer_cliente', { idCliente: String(idCliente) }).catch(() => ({}));
  ultimoOrigenPdf = 'generado';
  ultimoErrorPdf = adj.detalle;
  return pdfDesdeDatos(f.infofactura, f.itemsFactura || [], cliente || {});
}

// leer_facturaventa devuelve los datos fuera de response.data
async function colppyRaw2(provision, operacion, params) {
  const build = async force => ({ sesion: await colppyGetSesion(force), idEmpresa: COLPPY_ID_EMPRESA, ...params });
  let r = await colppyRaw(provision, operacion, await build(false));
  if (colppyFallo(r)) r = await colppyRaw(provision, operacion, await build(true));
  if (colppyFallo(r)) throw new Error(`Colppy ${provision}/${operacion}: ${r?.response?.message || 'error'}`);
  return r.response;
}

// ---------- Monto USD de facturas T / I / M ----------
function usdEnTexto(texto) {
  const t = String(texto || '');
  const re = /(?:usd|u\$s|us\$|u\$d)\s*:?\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(?:usd|u\$s|us\$|u\$d)\b/gi;
  let max = null, m;
  while ((m = re.exec(t))) {
    const v = parseUSD(`${m[1] || m[2]} usd`);
    if (v && (max == null || v > max)) max = v;
  }
  return max;
}

async function buscarUSDenFactura(idFactura) {
  const f = await colppyRaw2('FacturaVenta', 'leer_facturaventa', { idFactura: String(idFactura) });
  // 1) ítems de la factura
  let suma = 0, todos = true;
  for (const it of f.itemsFactura || []) {
    const u = parseUSD(`${it.Descripcion || ''} ${it.Comentario || ''}`);
    if (u) suma += u * (+it.Cantidad || 1); else todos = false;
  }
  if (suma > 0 && todos) return { usd: r2(suma), origen: 'ítems' };
  // 2) PDF adjunto en Colppy
  const adj = await colppyAdjunto(f);
  if (adj.buf) {
    try {
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(adj.buf), disableWorker: true, isEvalSupported: false }).promise;
      let text = '';
      for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
        const c = await (await doc.getPage(i)).getTextContent();
        text += c.items.map(x => x.str).join(' ') + '\n';
      }
      const u = usdEnTexto(text);
      if (u) return { usd: u, origen: 'PDF' };
    } catch (e) { console.warn('No se pudo leer el PDF', idFactura, e.message); }
  }
  return null;
}

// Una sola moneda por cliente: ARS si tiene alguna A o B; si no, USD cuando sus facturas son en dólares
function monedaCliente(facturas) {
  if (facturas.some(f => f.letra === 'A' || f.letra === 'B')) return 'ARS';
  if (facturas.some(f => SIEMPRE_USD.includes(f.letra) || f.usdFactura)) return 'USD';
  return 'ARS';
}

function aplicarMoneda(f, moneda) {
  if (moneda === 'ARS') { f.moneda = 'ARS'; f.importe = f.saldoARS; f.faltaUSD = false; return; }
  f.moneda = 'USD';
  if (f.usdFactura) { f.importe = r2(f.usdFactura * (f.totalARS ? f.saldoARS / f.totalARS : 1)); f.faltaUSD = false; }
  else { f.importe = 0; f.faltaUSD = true; }
}

function calcularTotales(m, ipc, hoy) {
  m.totales = { ARS: 0, USD: 0 }; m.intereses = { ARS: 0, USD: 0 };
  let ipcIncompleto = false;
  for (const f of m.facturas) {
    if (f.faltaUSD) continue;
    m.totales[f.moneda] = r2(m.totales[f.moneda] + f.importe);
    if (m.tipoMail === 'mora') {
      const i = calcularIntereses(f.importe, f.venc, ipc, hoy);
      Object.assign(f, { meses: i.meses, interes: i.interes });
      m.intereses[f.moneda] = r2(m.intereses[f.moneda] + i.interes);
      if (i.usaFallback) ipcIncompleto = true;
    }
  }
  m.faltaUSD = m.facturas.some(f => f.faltaUSD);
  m.problemas = (m.problemas || []).filter(p => !p.startsWith('Faltan meses de IPC'));
  if (ipcIncompleto) m.problemas.push(`Faltan meses de IPC: se usa ${TASA_FALLBACK}% mensual`);
}

// ---------- Gmail con refresh token ----------
function oauthClient() {
  return new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, GMAIL_REDIRECT);
}
const oauthStates = new Map(); // state -> timestamp

async function gmailCuenta(pool) {
  const r = await pool.query(`SELECT value FROM config WHERE key='gmail_refresh'`);
  return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
}

async function gmailAccessToken(pool) {
  const cuenta = await gmailCuenta(pool);
  if (!cuenta?.refresh_token) throw Object.assign(new Error('Gmail no está conectado'), { code: 'GMAIL' });
  const c = oauthClient();
  c.setCredentials({ refresh_token: cuenta.refresh_token });
  try {
    const { token } = await c.getAccessToken();
    if (!token) throw new Error('sin token');
    return { token, email: cuenta.email };
  } catch (e) {
    throw Object.assign(new Error('Gmail perdió la autorización. Volvé a conectarlo.'), { code: 'GMAIL' });
  }
}

function armarMime({ fromEmail, to, toName, cc, subject, html, adjuntos }) {
  const boundary = 'huerta_' + crypto.randomBytes(8).toString('hex');
  const enc = s => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${enc(FROM_NAME)} <${fromEmail}>`,
    `To: ${enc(toName)} <${to[0]}>${to.slice(1).map(e => `, <${e}>`).join('')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : null,
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].filter(l => l !== null);
  for (const a of adjuntos) {
    lines.push(`--${boundary}`,
      `Content-Type: application/pdf; name="${enc(a.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${enc(a.filename)}"`,
      '', a.buf.toString('base64').replace(/.{76}/g, '$&\r\n'));
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

async function gmailEnviar(token, raw) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 55000);
  try {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
    });
    const d = await r.json();
    if (!r.ok) throw Object.assign(new Error(d?.error?.message || 'Error de Gmail'), { code: r.status === 401 ? 'GMAIL' : undefined });
    return d.id;
  } finally { clearTimeout(t); }
}

// ---------- Intereses ----------
function calcularIntereses(importe, venc, ipc, hoy) {
  const [vy, vm] = venc.split('-').map(Number);
  // Hasta el último mes publicado por el INDEC (si no hay ningún dato, hasta el mes actual con la tasa de respaldo)
  const publicados = Object.keys(ipc).sort();
  const tope = publicados.length ? publicados[publicados.length - 1] : hoy.slice(0, 7);
  const [hy, hm] = (tope < hoy.slice(0, 7) ? tope : hoy.slice(0, 7)).split('-').map(Number);
  let y = vy, m = vm + 1; if (m > 12) { m = 1; y++; }
  let factor = 1, meses = 0, usaFallback = false;
  while (y < hy || (y === hy && m <= hm)) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    const tasa = ipc[k];
    if (tasa == null) usaFallback = true;
    factor *= 1 + (tasa ?? TASA_FALLBACK) / 100;
    meses++;
    m++; if (m > 12) { m = 1; y++; }
  }
  return { meses, interes: r2(importe * (factor - 1)), usaFallback, hasta: `${hy}-${String(hm).padStart(2, '0')}` };
}

// ---------- Armado de mails ----------
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const fechaLarga = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d} de ${MESES[+m - 1]} de ${y}`; };
const fmtCorto = (n, moneda) => (moneda === 'USD' ? 'USD ' : '$') +
  n.toLocaleString('es-AR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const nombreSaludo = c => {
  const n = String(c.contacto || '').trim().split(/\s+/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : c.empresa;
};
const nombresAdjuntos = c => [
  ...c.facturas.map(f => `${f.nro}.pdf`),
  ...(c.totales.ARS > 0 ? ['Datos bancarios CBU'] : []),
  ...(c.totales.USD > 0 ? ['Datos bancarios Mercury'] : []),
];

function armarHtml(c, adjuntos) {
  const { tipoMail, empresa, facturas } = c;
  const mora = tipoMail === 'mora';
  const n = facturas.length;
  const sede = (c.sedes || [])[0] || '';
  const ccSede = (c.cc || []).find(e => !CC_FIJOS.includes(e)) || '';
  const monedas = ['ARS', 'USD'].filter(m => c.totales[m] > 0);
  const F = 'font-family:Arial,Helvetica,sans-serif;';
  const MONO = "font-family:'SFMono-Regular',Menlo,Consolas,monospace;";
  const suave = tipoMail === 'recordatorio';
  const ROJO = suave ? '#222222' : '#C0392B', GRIS = '#8A8A8A', BEIGE = '#F5F2EC', LINEA = '#E8E3DA';

  const badge = d => {
    if (d <= 0) return `<span style="background:#E3F1E4;color:#2E7D32;font-size:11px;font-weight:bold;padding:2px 7px;border-radius:4px">${d === 0 ? 'hoy' : 'vigente'}</span>`;
    const [bg, fg] = d > 30 ? ['#FBE3E1', ROJO] : ['#FBF0D9', '#B7791F'];
    return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:bold;padding:2px 7px;border-radius:4px">${d}d</span>`;
  };
  const td = (s, extra = '') => `<td style="padding:12px 10px;border-top:1px solid ${LINEA};font-size:13px;white-space:nowrap;${extra}">${s}</td>`;
  const th = (s, extra = '') => `<td style="padding:10px 10px;border-top:1px solid ${LINEA};font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};${extra}">${s}</td>`;

  const filas = facturas.map(f => `<tr>
    ${td(esc(f.nro), MONO + 'color:#666')}
    ${td(f.emision ? fechaAR(f.emision) : '-', 'color:#666')}
    ${td(fechaAR(f.venc))}
    ${td(esc(f.letra || '-'))}
    ${td(fmtCorto(f.importe, f.moneda), MONO + `color:${ROJO};font-weight:bold;text-align:right`)}
    ${mora ? td(fmtCorto(f.interes || 0, f.moneda), MONO + 'text-align:right;color:#666') : ''}
    ${td(badge(f.diasVencida), 'text-align:center')}
  </tr>`).join('');
  const filaTotal = monedas.map(m => `<tr style="background:${BEIGE}">
    <td colspan="4" style="padding:12px 14px;border-top:1px solid ${LINEA};font-weight:bold;font-size:13px">TOTAL${monedas.length > 1 ? ' ' + m : ''}</td>
    <td style="padding:12px 14px;border-top:1px solid ${LINEA};${MONO}color:${ROJO};font-weight:bold;text-align:right;font-size:13px">${fmtCorto(c.totales[m], m)}</td>
    ${mora ? `<td style="padding:12px 14px;border-top:1px solid ${LINEA};${MONO}text-align:right;font-size:13px;color:#666">${fmtCorto(c.intereses[m] || 0, m)}</td>` : ''}
    <td style="border-top:1px solid ${LINEA}"></td></tr>`).join('');

  const unaVarias = (una, varias) => n === 1 ? una : varias;
  const p = s => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#333">${s}</p>`;
  let cuerpo;
  if (tipoMail === 'recordatorio') {
    cuerpo = p(`Hola ${esc(nombreSaludo(c))}, te escribimos solo para recordarte que ${unaVarias('la factura de este mes vence', 'las facturas de este mes vencen')} el día 10. Abajo te dejamos el detalle y los datos para el pago.`)
      + p('Si ya lo abonaste, muchas gracias y podés ignorar este mensaje. Cualquier consulta, respondé este email.');
  } else if (tipoMail === 'reclamo1') {
    cuerpo = p(`Hola ${esc(nombreSaludo(c))}, te contactamos porque registramos ${unaVarias('una factura impaga', `${n} facturas impagas`)} en tu cuenta. Te pedimos que regularices la situación a la brevedad.`)
      + p('Si ya realizaste el pago, por favor respondé este email con el comprobante. Quedamos a disposición.');
  } else if (tipoMail === 'reclamo2') {
    cuerpo = p(`Hola ${esc(nombreSaludo(c))}, te escribimos nuevamente porque ${unaVarias('la factura sigue impaga', `las ${n} facturas siguen impagas`)} a pesar de nuestro aviso anterior. Necesitamos que regularices la situación dentro de las próximas 48 horas.`)
      + p('Si ya realizaste el pago, por favor respondé este email con el comprobante. Quedamos a disposición.');
  } else {
    cuerpo = p(`Hola ${esc(nombreSaludo(c))}, la cuenta de ${esc(empresa)} registra facturas con más de ${DIAS_MORA} días de atraso y se encuentra en revisión.`)
      + p('Sobre el capital adeudado se aplican intereses por actualización (IPC INDEC), acumulados desde el mes siguiente a cada vencimiento.')
      + `<table width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 12px"><tr>
          <td style="padding:14px;background:${BEIGE};border-radius:6px 0 0 6px;vertical-align:top">
            <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS}">SI PAGÁS EN 10 DÍAS (SIN INTERESES)</div>
            <div style="font-size:18px;font-weight:bold;color:#222;margin-top:6px">${monedas.map(m => fmtCorto(c.totales[m], m)).join('<br>')}</div></td>
          <td style="padding:14px;background:#FBE3E1;border-radius:0 6px 6px 0;vertical-align:top">
            <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${ROJO}">TOTAL CON INTERESES</div>
            <div style="font-size:18px;font-weight:bold;color:${ROJO};margin-top:6px">${monedas.map(m => fmtCorto(r2(c.totales[m] + (c.intereses[m] || 0)), m)).join('<br>')}</div></td>
        </tr></table>`
      + p('Si ya realizaste el pago, por favor respondé este email con el comprobante.');
  }

  const instrucciones = [
    ...(c.totales.ARS > 0 ? ['Para pagos en pesos, realizá la transferencia bancaria al CBU de Huerta Coworking (adjunto).'] : []),
    ...(c.totales.USD > 0 ? ['Para pagos en dólares, realizá la transferencia a la cuenta Mercury de Huerta Coworking (adjunto).'] : []),
  ].map(s => `<div style="font-size:13px;color:#333;margin-top:4px">&bull; ${s}</div>`).join('');

  const listaAdj = (adjuntos || nombresAdjuntos(c)).map(a =>
    `<span style="display:inline-block;background:#F1EEE8;border-radius:6px;padding:8px 12px;margin:0 6px 6px 0;font-size:12px;font-weight:bold;color:#333">&#128206; ${esc(a)}</span>`).join('');

  const totalHeader = monedas.map(m => `<div style="font-size:24px;font-weight:bold;color:${ROJO};${MONO}">${fmtCorto(c.totales[m], m)}</div>`).join('');

  return `<div style="background:#ffffff;padding:0;margin:0">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;${F}border-collapse:collapse">
  <tr><td style="background:#111111;padding:16px 20px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="64"><div style="width:64px;height:64px;background:#ffffff;border-radius:8px;text-align:center;line-height:64px;font-size:34px;color:#111;font-family:Georgia,serif">H</div></td>
      <td style="text-align:center;color:#ffffff;font-size:18px;font-weight:bold">Huerta Coworking</td>
      <td width="110" style="text-align:right">${sede ? `<span style="background:#ffffff;color:#C2410C;font-size:12px;font-weight:bold;padding:5px 10px;border-radius:4px">&#128205; ${esc(sede)}</span>` : ''}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${BEIGE};padding:18px 26px;border-bottom:1px solid ${LINEA}">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:40px;border-right:1px solid #D6D0C4;vertical-align:top">
        <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};margin-bottom:6px">${mora ? 'CAPITAL ADEUDADO' : suave ? 'TOTAL' : 'TOTAL PENDIENTE'}</div>${totalHeader}</td>
      <td style="padding-left:40px;vertical-align:top;text-align:center">
        <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};margin-bottom:6px">FACTURAS</div>
        <div style="font-size:24px;font-weight:bold;color:#333">${n}</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 26px 8px">${cuerpo}
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINEA};border-radius:8px;border-collapse:separate;margin:8px 0 16px;background:#FBFAF8">
      <tr><td colspan="${mora ? 7 : 6}" style="padding:12px 14px;font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS}">DETALLE DE FACTURAS &middot; ${esc(empresa.toUpperCase())}</td></tr>
      <tr>${th('REFERENCIA')}${th('EMISIÓN')}${th('VENCIMIENTO')}${th('TIPO')}${th('MONTO', 'text-align:right')}${mora ? th('INTERÉS', 'text-align:right') : ''}${th('ESTADO', 'text-align:center')}</tr>
      ${filas}${filaTotal}
    </table>
    <div style="border:1px solid #BFE0C3;background:#EEF8EF;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:#2E7D32">INSTRUCCIONES DE PAGO</div>${instrucciones}
    </div>
    <div style="border-top:1px solid ${LINEA};padding-top:14px;margin-bottom:16px">
      <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};margin-bottom:10px">ADJUNTOS</div>${listaAdj}
    </div>
  </td></tr>
  <tr><td style="background:${BEIGE};padding:14px 26px;font-size:11px;color:${GRIS}">
    ${sede ? `&#128205; ${esc(sede)}` : 'Huerta Coworking'}${ccSede ? ` &middot; <a href="mailto:${ccSede}" style="color:#1a56db">${ccSede}</a>` : ''}
  </td></tr>
</table></div>`;
}

// ---------- Rutas ----------
module.exports = function montarReclamos(app, pool) {
  const admin = (req, res, next) => {
    const k = req.get('x-admin-key') || '';
    const ok = ADMIN_KEY && k.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
    if (!ok) return res.status(401).json({ error: 'Clave de acceso incorrecta' });
    next();
  };

  pool.query(`
    CREATE TABLE IF NOT EXISTS reclamos_lotes (id TEXT PRIMARY KEY, tipo TEXT, data JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS reclamos_envios (
      id SERIAL PRIMARY KEY, lote_id TEXT, id_cliente TEXT, empresa TEXT, email TEXT, tipo_mail TEXT,
      facturas JSONB, estado TEXT, message_id TEXT, detalle TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS reclamos_envios_lote_cliente ON reclamos_envios(lote_id, id_cliente);
    CREATE INDEX IF NOT EXISTS reclamos_envios_cliente_fecha ON reclamos_envios(id_cliente, created_at);
    CREATE TABLE IF NOT EXISTS reclamos_contactos (id_cliente TEXT PRIMARY KEY, email TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE reclamos_contactos ADD COLUMN IF NOT EXISTS contacto TEXT;
    ALTER TABLE reclamos_contactos ADD COLUMN IF NOT EXISTS excluido BOOLEAN DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS reclamos_intereses (id SERIAL PRIMARY KEY, id_factura TEXT, id_cliente TEXT, nro TEXT, moneda TEXT,
      interes NUMERIC, factura_interes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS reclamos_intereses_factura ON reclamos_intereses(id_factura);
    CREATE TABLE IF NOT EXISTS reclamos_usd (id_factura TEXT PRIMARY KEY, nro TEXT, usd NUMERIC, updated_at TIMESTAMPTZ DEFAULT NOW());
  `).then(() => console.log('Reclamos: tablas listas')).catch(e => console.error('Reclamos: error creando tablas', e.message));

  async function leerIPC() {
    const r = await pool.query(`SELECT value FROM config WHERE key='ipc'`);
    try { return r.rows[0] ? JSON.parse(r.rows[0].value) : {}; } catch { return {}; }
  }

  // IPC automático desde la API de series de datos.gob.ar (publica las series del INDEC)
  const IPC_SERIE = process.env.IPC_SERIE_ID || '148.3_INIVELNAL_DICI_M_26'; // IPC Nivel General Nacional, base dic-2016
  let ipcUltimoIntento = 0, ipcUltimoError = '';
  async function actualizarIPC(force = false) {
    if (!force && Date.now() - ipcUltimoIntento < 6 * 3600e3) return;
    ipcUltimoIntento = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const url = `https://apis.datos.gob.ar/series/api/series/?ids=${IPC_SERIE}&representation_mode=percent_change&format=json&start_date=2016-12-01&limit=1000`;
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'huerta-backend' } });
      if (!r.ok) throw new Error('la API respondió HTTP ' + r.status);
      const d = await r.json();
      const nuevos = {};
      for (const [fecha, v] of d.data || []) {
        if (v == null || !isFinite(v)) continue;
        const pct = v * 100;
        if (pct < -5 || pct > 50) continue;
        nuevos[String(fecha).slice(0, 7)] = Math.round(pct * 10) / 10; // INDEC publica con 1 decimal
      }
      const meses = Object.keys(nuevos).sort();
      if (meses.length < 12) throw new Error('la API no devolvió datos');
      const actual = await leerIPC();
      await pool.query(`INSERT INTO config (key, value) VALUES ('ipc', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify({ ...actual, ...nuevos })]);
      await pool.query(`INSERT INTO config (key, value) VALUES ('ipc_fuente', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
        [JSON.stringify({ fuente: 'INDEC (datos.gob.ar)', ultimo: meses[meses.length - 1], ts: new Date().toISOString() })]);
      ipcUltimoError = '';
      console.log('IPC actualizado hasta', meses[meses.length - 1]);
    } catch (e) {
      ipcUltimoError = e.name === 'AbortError' ? 'la API no respondió a tiempo' : e.message;
      console.warn('IPC: no se pudo actualizar:', ipcUltimoError);
    } finally { clearTimeout(t); }
  }
  setTimeout(() => actualizarIPC(true), 5000);

  app.post('/api/reclamos/ipc/actualizar', admin, async (req, res) => {
    await actualizarIPC(true);
    const ipc = await leerIPC();
    const meses = Object.keys(ipc).sort();
    res.json({ ok: !ipcUltimoError, error: ipcUltimoError || null, meses: meses.length, ultimo: meses[meses.length - 1] || null });
  });

  // Estado general
  app.get('/api/reclamos/estado', admin, async (req, res) => {
    try {
      const cuenta = await gmailCuenta(pool);
      await actualizarIPC();
      const ipc = await leerIPC();
      const meses = Object.keys(ipc).sort();
      const fr = await pool.query(`SELECT value FROM config WHERE key='ipc_fuente'`);
      const fuente = fr.rows[0] ? JSON.parse(fr.rows[0].value) : null;
      res.json({
        gmail: { conectado: !!cuenta?.refresh_token, email: cuenta?.email || null },
        colppy: { configurado: !!process.env.COLPPY_PASS },
        ipc: { meses: meses.length, ultimo: meses[meses.length - 1] || null, fuente: fuente?.fuente || null, error: ipcUltimoError || null },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Gmail: conectar una sola vez
  app.get('/api/gmail/conectar-url', admin, (req, res) => {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Faltan GMAIL_CLIENT_ID o GMAIL_CLIENT_SECRET en Render' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now());
    const url = oauthClient().generateAuthUrl({
      access_type: 'offline', prompt: 'consent', state,
      scope: ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'],
    });
    res.json({ url });
  });

  app.get('/api/gmail/oauth2callback', async (req, res) => {
    const pagina = (titulo, texto) => res.send(`<!doctype html><meta charset="utf-8"><title>${titulo}</title>
      <body style="font-family:system-ui;padding:40px;max-width:520px"><h2>${titulo}</h2><p>${texto}</p></body>`);
    try {
      const { code, state, error } = req.query;
      if (error) return pagina('No se conectó Gmail', esc(error));
      const ts = oauthStates.get(state);
      oauthStates.delete(state);
      if (!ts || Date.now() - ts > 15 * 60e3) return pagina('Link vencido', 'Volvé al sistema y tocá Conectar Gmail de nuevo.');
      const c = oauthClient();
      const { tokens } = await c.getToken(code);
      if (!tokens.refresh_token) return pagina('Falta autorización', 'Google no devolvió el permiso permanente. Quitá el acceso de la app en tu cuenta de Google y conectá de nuevo.');
      let email = null;
      if (tokens.id_token) {
        const t = await c.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GMAIL_CLIENT_ID });
        email = t.getPayload()?.email || null;
      }
      await pool.query(`INSERT INTO config (key, value) VALUES ('gmail_refresh', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
        [JSON.stringify({ refresh_token: tokens.refresh_token, email, ts: new Date().toISOString() })]);
      pagina('Gmail conectado', `Los mails se van a enviar desde <b>${esc(email || 'la cuenta autorizada')}</b>. Ya podés cerrar esta pestaña.`);
    } catch (e) { pagina('Error', esc(e.message)); }
  });

  // IPC: {"2026-01": 2.2, ...} en % mensual
  app.post('/api/reclamos/ipc', admin, async (req, res) => {
    try {
      const ipc = req.body?.ipc || {};
      const limpio = {};
      for (const [k, v] of Object.entries(ipc)) if (/^\d{4}-\d{2}$/.test(k) && isFinite(+v)) limpio[k] = +v;
      if (!Object.keys(limpio).length) return res.status(400).json({ error: 'Formato: {"ipc": {"2026-01": 2.2}}' });
      const actual = await leerIPC();
      await pool.query(`INSERT INTO config (key, value) VALUES ('ipc', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
        [JSON.stringify({ ...actual, ...limpio })]);
      res.json({ ok: true, meses: Object.keys({ ...actual, ...limpio }).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Preparar lote: trae todo de Colppy y arma los mails (no envía nada)
  app.post('/api/reclamos/preparar', admin, async (req, res) => {
    try {
      const tipo = req.body?.tipo;
      if (!['recordatorio', 'reclamo1', 'reclamo2'].includes(tipo)) return res.status(400).json({ error: 'Tipo de mail inválido' });
      const hoy = hoyAR();
      await actualizarIPC();
      const ipc = await leerIPC();
      const crudas = await colppyFacturasPendientes();

      // Normalizar facturas
      const porCliente = new Map();
      for (const f of crudas) {
        const total = +f.totalFactura || 0;
        const saldo = r2(total - (+f.totalaplicado || 0));
        if (saldo <= 1) continue;
        const letra = LETRAS[f.idTipoFactura] || '';
        const esAB = letra === 'A' || letra === 'B';
        const emision = String(f.fechaFactura).slice(0, 10);
        const venc = vencimientoDia10(emision, String(f.fechaPago || '').slice(0, 10));
        const diasVencida = Math.floor((Date.parse(hoy) - Date.parse(venc)) / 86400000);
        const pv = String(f.nroFactura || '').split('-')[0];
        const fac = {
          idFactura: f.idFactura, nro: f.nroFactura, letra, descripcion: f.descripcion, emision, venc, diasVencida,
          saldoARS: saldo, totalARS: total, usdFactura: esAB ? null : parseUSD(f.descripcion), usdOrigen: '',
          tieneCAE: !!f.cae, pv,
        };
        if (fac.usdFactura) fac.usdOrigen = 'concepto';
        if (!porCliente.has(f.idCliente)) porCliente.set(f.idCliente, { idCliente: f.idCliente, empresa: (f.RazonSocial || f.NombreFantasia || '').trim(), facturas: [] });
        porCliente.get(f.idCliente).facturas.push(fac);
      }

      // Montos USD: cargados a mano, o buscados dentro de la factura
      const manual = new Map((await pool.query(`SELECT id_factura, usd FROM reclamos_usd`)).rows.map(r => [r.id_factura, +r.usd]));
      const buscar = [];
      for (const c of porCliente.values()) {
        for (const f of c.facturas) if (manual.has(f.idFactura)) { f.usdFactura = manual.get(f.idFactura); f.usdOrigen = 'cargado'; }
        c.moneda = monedaCliente(c.facturas);
        if (c.moneda === 'USD') for (const f of c.facturas) if (!f.usdFactura) buscar.push(f);
      }
      for (let i = 0; i < buscar.length; i += 4) {
        await Promise.all(buscar.slice(i, i + 4).map(async f => {
          try { const r = await buscarUSDenFactura(f.idFactura); if (r) { f.usdFactura = r.usd; f.usdOrigen = r.origen; } }
          catch (e) { console.warn('USD no encontrado', f.nro, e.message); }
        }));
      }
      for (const c of porCliente.values()) c.facturas.forEach(f => aplicarMoneda(f, c.moneda));

      // Emails guardados
      const [ovr, facEm, cliEm] = await Promise.all([
        pool.query(`SELECT id_cliente, email, contacto, excluido FROM reclamos_contactos`),
        pool.query(`SELECT DISTINCT ON (lower(trim(empresa))) lower(trim(empresa)) k, email FROM facturas WHERE email <> '' ORDER BY lower(trim(empresa)), created_at DESC`),
        pool.query(`SELECT lower(trim(empresa)) k, email, contacto FROM clientes`),
      ]);
      const mOvr = new Map(ovr.rows.map(r => [r.id_cliente, r.email]));
      const mOvrFull = new Map(ovr.rows.map(r => [r.id_cliente, r]));
      const mFac = new Map(facEm.rows.map(r => [claveEmpresa(r.k), r.email]));
      const mCli = new Map(cliEm.rows.map(r => [claveEmpresa(r.k), r.email]));
      const mContacto = new Map(cliEm.rows.map(r => [claveEmpresa(r.k), r.contacto]));

      const recientes = await pool.query(
        `SELECT DISTINCT id_cliente FROM reclamos_envios WHERE estado='enviado' AND created_at > NOW() - ($1 || ' hours')::interval`,
        [String(HORAS_BLOQUEO_REENVIO)]);
      const yaEnviados = new Set(recientes.rows.map(r => r.id_cliente));

      const mails = [];
      const faltanEmail = [];
      for (const c of porCliente.values()) {
        const maxDias = Math.max(...c.facturas.map(f => f.diasVencida));
        const tipoMail = maxDias > DIAS_MORA ? 'mora' : tipo;
        let facturas = c.facturas;
        if (tipoMail === 'reclamo1' || tipoMail === 'reclamo2') facturas = facturas.filter(f => f.diasVencida > 0);
        if (tipoMail === 'recordatorio') facturas = facturas.filter(f => f.diasVencida <= 0);
        if (!facturas.length) continue;
        facturas.sort((a, b) => a.venc.localeCompare(b.venc));

        const k = claveEmpresa(c.empresa);
        const tieneUSD = c.moneda === 'USD';
        let email = [], origen = '';
        const candidatos = [
          ['editado', mOvr.get(c.idCliente)],
          ...(tieneUSD ? [['contacto USD', mFac.get(k)], ['clientes', mCli.get(k)]] : [['clientes', mCli.get(k)], ['facturas', mFac.get(k)]]),
        ];
        for (const [o, v] of candidatos) { const e = limpiarEmails(v); if (e.length) { email = e; origen = o; break; } }

        const sedes = [...new Set(facturas.map(f => sedeDePV(f.pv)).filter(Boolean))];
        const cc = [...new Set([...CC_FIJOS, ...sedes.map(s => s.cc)])];
        const problemas = [];
        if (yaEnviados.has(c.idCliente)) problemas.push(`Ya recibió un mail en las últimas ${HORAS_BLOQUEO_REENVIO} horas`);

        const mail = {
          idCliente: c.idCliente, moneda: c.moneda, empresa: c.empresa, contacto: mOvrFull.get(c.idCliente)?.contacto || mContacto.get(k) || '',
          excluido: !!mOvrFull.get(c.idCliente)?.excluido, email, emailOrigen: origen, cc,
          sedes: sedes.map(s => s.sede), tipoMail, asunto: TIPOS[tipoMail].asunto(c.empresa),
          facturas, problemas, bloqueado: yaEnviados.has(c.idCliente),
        };
        calcularTotales(mail, ipc, hoy);
        if (!email.length) faltanEmail.push(mail);
        mails.push(mail);
      }

      // Último recurso: email de Colppy para los que no tienen (de a 5 en paralelo)
      for (let i = 0; i < faltanEmail.length; i += 5) {
        await Promise.all(faltanEmail.slice(i, i + 5).map(async m => {
          const e = await colppyEmailCliente(m.idCliente);
          if (e.length) { m.email = e; m.emailOrigen = 'Colppy'; }
          else m.problemas.unshift('Sin email: cargalo para poder enviar');
        }));
      }

      mails.sort((a, b) => (b.tipoMail === 'mora') - (a.tipoMail === 'mora') || a.empresa.localeCompare(b.empresa));
      if (mails.length > MAX_MAILS_POR_LOTE) return res.status(400).json({ error: `El lote tiene ${mails.length} mails, más que el máximo permitido (${MAX_MAILS_POR_LOTE}). Revisá Colppy.` });

      const loteId = crypto.randomBytes(8).toString('hex');
      await pool.query(`DELETE FROM reclamos_lotes WHERE created_at < NOW() - interval '7 days'`);
      await pool.query(`INSERT INTO reclamos_lotes (id, tipo, data) VALUES ($1,$2,$3)`, [loteId, tipo, JSON.stringify(mails)]);

      const resumen = {
        mails: mails.length,
        enviables: mails.filter(m => m.email.length && !m.bloqueado && !m.faltaUSD && !m.excluido).length,
        faltaUSD: mails.filter(m => m.faltaUSD).length,
        mora: mails.filter(m => m.tipoMail === 'mora').length,
        sinEmail: mails.filter(m => !m.email.length).length,
        totalARS: r2(mails.reduce((s, m) => s + m.totales.ARS, 0)),
        totalUSD: r2(mails.reduce((s, m) => s + m.totales.USD, 0)),
        facturas: mails.reduce((s, m) => s + m.facturas.length, 0),
      };
      res.json({ ok: true, loteId, tipo, resumen, mails });
    } catch (e) {
      console.error('preparar:', e);
      res.status(500).json({ error: e.message });
    }
  });

  async function leerLote(loteId) {
    const r = await pool.query(`SELECT data, created_at FROM reclamos_lotes WHERE id=$1`, [loteId]);
    if (!r.rows[0]) throw new Error('Lote no encontrado. Volvé a buscar facturas.');
    if (Date.now() - new Date(r.rows[0].created_at).getTime() > LOTE_VALIDO_HORAS * 3600e3) throw new Error('Lote vencido. Volvé a buscar facturas.');
    return r.rows[0].data;
  }

  // Vista previa del mail de un cliente
  app.get('/api/reclamos/preview', admin, async (req, res) => {
    try {
      const mails = await leerLote(req.query.loteId);
      const m = mails.find(x => x.idCliente === req.query.idCliente);
      if (!m) return res.status(404).json({ error: 'Cliente no está en el lote' });
      res.json({ asunto: m.asunto, to: m.email, cc: m.cc, html: armarHtml(m) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Enviar UN cliente del lote (el frontend los llama de a uno, en orden)
  app.post('/api/reclamos/enviar', admin, async (req, res) => {
    const { loteId, idCliente, email: emailEditado } = req.body || {};
    let registrado = false;
    try {
      const mails = await leerLote(loteId);
      const m = mails.find(x => x.idCliente === idCliente);
      if (!m) return res.status(404).json({ error: 'Cliente no está en el lote' });

      let to = m.email;
      if (emailEditado != null) {
        const e = limpiarEmails(emailEditado);
        if (!e.length) return res.status(400).json({ error: `Email inválido para ${m.empresa}` });
        if (e.join(',') !== m.email.join(',')) {
          to = e;
          await pool.query(`INSERT INTO reclamos_contactos (id_cliente, email, updated_at) VALUES ($1,$2,NOW())
            ON CONFLICT (id_cliente) DO UPDATE SET email=$2, updated_at=NOW()`, [idCliente, e.join(', ')]);
        }
      }
      if (m.excluido) return res.status(400).json({ error: `${m.empresa} está excluido de los reclamos` });
      if (!to.length) return res.status(400).json({ error: `${m.empresa} no tiene email` });
      if (m.facturas.some(f => f.faltaUSD)) return res.status(400).json({ error: `${m.empresa}: falta cargar el monto USD de ${m.facturas.filter(f => f.faltaUSD).map(f => f.nro).join(', ')}` });

      // Bloqueo de reenvío: mismo cliente en las últimas horas
      const rec = await pool.query(
        `SELECT 1 FROM reclamos_envios WHERE id_cliente=$1 AND estado='enviado' AND created_at > NOW() - ($2 || ' hours')::interval LIMIT 1`,
        [idCliente, String(HORAS_BLOQUEO_REENVIO)]);
      if (rec.rowCount) return res.json({ ok: true, omitido: true, motivo: 'Ya se le envió un mail recientemente' });

      // Reserva: un solo intento por cliente y lote (evita doble click o reintentos)
      await pool.query(`DELETE FROM reclamos_envios WHERE lote_id=$1 AND id_cliente=$2 AND estado='error'`, [loteId, idCliente]);
      const ins = await pool.query(
        `INSERT INTO reclamos_envios (lote_id, id_cliente, empresa, email, tipo_mail, facturas, estado)
         VALUES ($1,$2,$3,$4,$5,$6,'enviando') ON CONFLICT (lote_id, id_cliente) DO NOTHING`,
        [loteId, idCliente, m.empresa, to.join(', '), m.tipoMail, JSON.stringify(m.facturas.map(f => f.nro))]);
      if (!ins.rowCount) return res.json({ ok: true, omitido: true, motivo: 'Ya se procesó en este lote' });
      registrado = true;

      const { token, email: fromEmail } = await gmailAccessToken(pool);

      // Adjuntos: PDF de cada factura desde Colppy + datos bancarios
      const adjuntos = [];
      const sinPdf = [];
      for (const f of m.facturas) {
        const buf = await colppyPdfFactura(f.idFactura, idCliente);
        if (buf) adjuntos.push({ filename: `${f.nro}.pdf`, buf });
        else sinPdf.push(f.nro);
      }
      const bancos = await pool.query(`SELECT tipo, nombre, url FROM pdfs_banco`);
      const banco = Object.fromEntries(bancos.rows.map(r => [r.tipo, r]));
      for (const [mon, key] of [['ARS', 'cbu'], ['USD', 'merc']]) {
        if (m.totales[mon] > 0 && banco[key]?.url) {
          const r = await fetch(banco[key].url);
          if (r.ok) adjuntos.push({ filename: banco[key].nombre || `Datos bancarios ${mon}.pdf`, buf: Buffer.from(await r.arrayBuffer()) });
        }
      }

      const raw = armarMime({ fromEmail: fromEmail || process.env.GMAIL_FROM, to, toName: m.empresa, cc: m.cc, subject: m.asunto, html: armarHtml(m, adjuntos.map(a => a.filename)), adjuntos });
      if (raw.length > 24 * 1024 * 1024) throw new Error(`El mail de ${m.empresa} supera 24 MB`);
      const messageId = await gmailEnviar(token, raw);

      await pool.query(`UPDATE reclamos_envios SET estado='enviado', message_id=$3, detalle=$4 WHERE lote_id=$1 AND id_cliente=$2`,
        [loteId, idCliente, messageId, sinPdf.length ? 'Sin PDF: ' + sinPdf.join(', ') : null]);
      // Mantiene la tabla vieja al día para el sistema actual
      await pool.query(`UPDATE facturas SET sent=TRUE WHERE referencia = ANY($1)`, [m.facturas.map(f => f.nro)]).catch(() => {});

      res.json({ ok: true, messageId, sinPdf });
    } catch (e) {
      console.error('enviar:', idCliente, e.message);
      if (registrado) await pool.query(`UPDATE reclamos_envios SET estado='error', detalle=$3 WHERE lote_id=$1 AND id_cliente=$2`, [loteId, idCliente, e.message]).catch(() => {});
      res.status(e.code === 'GMAIL' ? 401 : 500).json({ error: e.message, gmail: e.code === 'GMAIL' });
    }
  });

  // Editar datos del cliente para reclamos (email, nombre del saludo, excluir)
  app.post('/api/reclamos/cliente', admin, async (req, res) => {
    try {
      const { loteId, idCliente } = req.body || {};
      const r = await pool.query(`SELECT data FROM reclamos_lotes WHERE id=$1`, [loteId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Lote no encontrado. Volvé a buscar facturas.' });
      const mails = r.rows[0].data;
      const m = mails.find(x => x.idCliente === idCliente);
      if (!m) return res.status(404).json({ error: 'Cliente no está en el lote' });
      const cambios = {};
      if (req.body.email != null) {
        const e = limpiarEmails(req.body.email);
        if (String(req.body.email).trim() && !e.length) return res.status(400).json({ error: 'Email inválido' });
        cambios.email = e.join(', '); m.email = e; m.emailOrigen = e.length ? 'editado' : '';
      }
      if (req.body.contacto != null) { cambios.contacto = String(req.body.contacto).trim().slice(0, 80); m.contacto = cambios.contacto; }
      if (req.body.excluido != null) { cambios.excluido = !!req.body.excluido; m.excluido = cambios.excluido; }
      const cols = Object.keys(cambios);
      if (!cols.length) return res.json({ ok: true, mail: m });
      await pool.query(
        `INSERT INTO reclamos_contactos (id_cliente, ${cols.join(', ')}, updated_at) VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')}, NOW())
         ON CONFLICT (id_cliente) DO UPDATE SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=NOW()`,
        [idCliente, ...cols.map(c => cambios[c])]);
      await pool.query(`UPDATE reclamos_lotes SET data=$2 WHERE id=$1`, [loteId, JSON.stringify(mails)]);
      res.json({ ok: true, mail: m });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cargar a mano el monto USD de una factura
  app.post('/api/reclamos/usd', admin, async (req, res) => {
    try {
      const { loteId, idCliente, idFactura } = req.body || {};
      const usd = parseUSD(`${req.body?.usd} usd`);
      if (!usd) return res.status(400).json({ error: 'Monto USD inválido' });
      const r = await pool.query(`SELECT data FROM reclamos_lotes WHERE id=$1`, [loteId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Lote no encontrado. Volvé a buscar facturas.' });
      const mails = r.rows[0].data;
      const m = mails.find(x => x.idCliente === idCliente);
      const f = m?.facturas.find(x => x.idFactura === idFactura);
      if (!f) return res.status(404).json({ error: 'Factura no está en el lote' });
      await pool.query(`INSERT INTO reclamos_usd (id_factura, nro, usd, updated_at) VALUES ($1,$2,$3,NOW())
        ON CONFLICT (id_factura) DO UPDATE SET usd=$3, updated_at=NOW()`, [idFactura, f.nro, usd]);
      f.usdFactura = usd; f.usdOrigen = 'cargado';
      aplicarMoneda(f, m.moneda || 'USD');
      calcularTotales(m, await leerIPC(), hoyAR());
      await pool.query(`UPDATE reclamos_lotes SET data=$2 WHERE id=$1`, [loteId, JSON.stringify(mails)]);
      res.json({ ok: true, mail: m });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const pub0 = ipc => { const k = Object.keys(ipc).sort().pop(); return k ? `${MESES_LARGOS[+k.slice(5) - 1]} ${k.slice(0, 4)}` : 'hoy'; };
  // Intereses de mora para facturar (descuenta lo ya facturado)
  async function interesesDeLote(loteId) {
    const mails = await leerLote(loteId);
    const ipc = await leerIPC(), hoy = hoyAR();
    const ya = await pool.query(`SELECT id_factura, SUM(interes) total, MAX(created_at) ultima, STRING_AGG(DISTINCT factura_interes, ', ') facturas
      FROM reclamos_intereses GROUP BY id_factura`);
    const mYa = new Map(ya.rows.map(r => [r.id_factura, r]));
    let ipcIncompleto = false;
    const clientes = [];
    for (const m of mails.filter(x => x.tipoMail === 'mora')) {
      const filas = [];
      for (const f of m.facturas) {
        if (f.faltaUSD || f.diasVencida <= 0) continue;
        const i = calcularIntereses(f.importe, f.venc, ipc, hoy);
        if (i.usaFallback) ipcIncompleto = true;
        const prev = mYa.get(f.idFactura);
        const facturado = r2(+(prev?.total || 0));
        const aFacturar = r2(Math.max(0, i.interes - facturado));
        filas.push({ idFactura: f.idFactura, nro: f.nro, letra: f.letra, emision: f.emision, venc: f.venc, diasVencida: f.diasVencida,
          capital: f.importe, meses: i.meses, interes: i.interes, facturado, aFacturar, facturasInteres: prev?.facturas || '' });
      }
      if (!filas.length) continue;
      const moneda = m.moneda || m.facturas[0].moneda;
      const total = r2(filas.reduce((t, f) => t + f.aFacturar, 0));
      const nros = filas.filter(f => f.aFacturar > 0).map(f => f.nro);
      clientes.push({
        idCliente: m.idCliente, empresa: m.empresa, sedes: m.sedes, moneda, filas, totalAFacturar: total,
        concepto: nros.length ? `Intereses por mora (actualización IPC hasta ${pub0(ipc)}) s/ facturas ${nros.join(', ')}` : '',
      });
    }
    clientes.sort((a, b) => b.totalAFacturar - a.totalAFacturar);
    const pub = Object.keys(ipc).sort();
    return { hoy, ipcIncompleto, tasaFallback: TASA_FALLBACK, ipcHasta: pub[pub.length - 1] || null, clientes };
  }

  app.get('/api/reclamos/intereses', admin, async (req, res) => {
    try { res.json(await interesesDeLote(req.query.loteId)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Registrar que se facturaron los intereses de un cliente
  app.post('/api/reclamos/intereses/facturado', admin, async (req, res) => {
    try {
      const { loteId, idCliente, facturaInteres } = req.body || {};
      const data = await interesesDeLote(loteId);
      const c = data.clientes.find(x => x.idCliente === idCliente);
      if (!c) return res.status(404).json({ error: 'Cliente sin intereses en este lote' });
      const filas = c.filas.filter(f => f.aFacturar > 0);
      if (!filas.length) return res.status(400).json({ error: 'No hay intereses pendientes de facturar' });
      for (const f of filas) {
        await pool.query(`INSERT INTO reclamos_intereses (id_factura, id_cliente, nro, moneda, interes, factura_interes) VALUES ($1,$2,$3,$4,$5,$6)`,
          [f.idFactura, idCliente, f.nro, c.moneda, f.aFacturar, String(facturaInteres || '').slice(0, 60)]);
      }
      res.json({ ok: true, registrado: c.totalAFacturar });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PDF de una factura (se descarga de Colppy en el momento)
  app.get('/api/reclamos/pdf', admin, async (req, res) => {
    try {
      const { idFactura, idCliente } = req.query;
      if (!/^\d+$/.test(idFactura || '') || !/^\d+$/.test(idCliente || '')) return res.status(400).json({ error: 'Factura inválida' });
      const buf = await colppyPdfFactura(idFactura, idCliente);
      if (!buf) return res.status(404).json({ error: 'Colppy no devolvió el PDF. Detalle: ' + (ultimoErrorPdf || 'sin datos') });
      res.set('Content-Type', 'application/pdf');
      res.set('X-Pdf-Origen', ultimoOrigenPdf || '');
      res.set('X-Pdf-Detalle', encodeURIComponent(ultimoOrigenPdf === 'generado' ? ultimoErrorPdf : ''));
      res.set('Access-Control-Expose-Headers', 'X-Pdf-Origen, X-Pdf-Detalle');
      res.send(buf);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/reclamos/historial', admin, async (req, res) => {
    try {
      const r = await pool.query(`SELECT empresa, email, tipo_mail, estado, detalle, created_at FROM reclamos_envios ORDER BY created_at DESC LIMIT 200`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

module.exports._test = { usdEnTexto, pdfDesdeDatos, parseUSD, calcularIntereses, armarHtml, armarMime, limpiarEmails };
