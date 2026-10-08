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

const DIAS_MORA = 90;
const TASA_FALLBACK = 2; // % mensual si falta el IPC de un mes
const HORAS_BLOQUEO_REENVIO = 20; // no se reenvía al mismo cliente dentro de este plazo
const MAX_MAILS_POR_LOTE = 200;
const LOTE_VALIDO_HORAS = 6;

const TIPOS = {
  recordatorio: { label: 'Recordatorio día 8', asunto: () => 'Factura próxima a vencer · Huerta Coworking' },
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

async function colppyPdfFactura(idFactura, idCliente) {
  for (const force of [false, true]) {
    const s = await colppyGetSesion(force);
    const q = new URLSearchParams({ usuario: s.usuario, claveSesion: s.claveSesion, idEmpresa: COLPPY_ID_EMPRESA, idFactura: String(idFactura), idCliente: String(idCliente) });
    try {
      const r = await fetch(`${COLPPY_PDF_URL}?${q}`);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.subarray(0, 4).toString() === '%PDF') return buf;
    } catch { /* reintenta con sesión nueva */ }
  }
  return null;
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
  const [hy, hm] = hoy.split('-').map(Number);
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
  return { meses, interes: r2(importe * (factor - 1)), usaFallback };
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
  const ROJO = '#C0392B', GRIS = '#8A8A8A', BEIGE = '#F5F2EC', LINEA = '#E8E3DA';

  const badge = d => {
    if (d <= 0) return `<span style="background:#E3F1E4;color:#2E7D32;font-size:11px;font-weight:bold;padding:2px 7px;border-radius:4px">${d === 0 ? 'hoy' : 'vigente'}</span>`;
    const [bg, fg] = d > 30 ? ['#FBE3E1', ROJO] : ['#FBF0D9', '#B7791F'];
    return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:bold;padding:2px 7px;border-radius:4px">${d}d</span>`;
  };
  const td = (s, extra = '') => `<td style="padding:12px 14px;border-top:1px solid ${LINEA};font-size:13px;${extra}">${s}</td>`;
  const th = (s, extra = '') => `<td style="padding:10px 14px;border-top:1px solid ${LINEA};font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};${extra}">${s}</td>`;

  const filas = facturas.map(f => `<tr>
    ${td(esc(f.nro), MONO + 'color:#666')}
    ${td(fechaLarga(f.venc))}
    ${td(esc(f.letra || '-'))}
    ${td(fmtCorto(f.importe, f.moneda), MONO + `color:${ROJO};font-weight:bold;text-align:right`)}
    ${mora ? td(fmtCorto(f.interes || 0, f.moneda), MONO + 'text-align:right;color:#666') : ''}
    ${td(badge(f.diasVencida), 'text-align:center')}
  </tr>`).join('');
  const filaTotal = monedas.map(m => `<tr style="background:${BEIGE}">
    <td colspan="3" style="padding:12px 14px;border-top:1px solid ${LINEA};font-weight:bold;font-size:13px">TOTAL${monedas.length > 1 ? ' ' + m : ''}</td>
    <td style="padding:12px 14px;border-top:1px solid ${LINEA};${MONO}color:${ROJO};font-weight:bold;text-align:right;font-size:13px">${fmtCorto(c.totales[m], m)}</td>
    ${mora ? `<td style="padding:12px 14px;border-top:1px solid ${LINEA};${MONO}text-align:right;font-size:13px;color:#666">${fmtCorto(c.intereses[m] || 0, m)}</td>` : ''}
    <td style="border-top:1px solid ${LINEA}"></td></tr>`).join('');

  const unaVarias = (una, varias) => n === 1 ? una : varias;
  const p = s => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#333">${s}</p>`;
  let cuerpo;
  if (tipoMail === 'recordatorio') {
    cuerpo = p(`Hola ${esc(nombreSaludo(c))}, te recordamos que ${unaVarias('tenés una factura pendiente', `tenés ${n} facturas pendientes`)} en tu cuenta. Las facturas del mes vencen el día 10.`)
      + p('Si ya realizaste el pago, por favor respondé este email con el comprobante. Quedamos a disposición.');
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
        <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};margin-bottom:6px">${mora ? 'CAPITAL ADEUDADO' : 'TOTAL PENDIENTE'}</div>${totalHeader}</td>
      <td style="padding-left:40px;vertical-align:top;text-align:center">
        <div style="font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS};margin-bottom:6px">FACTURAS</div>
        <div style="font-size:24px;font-weight:bold;color:#333">${n}</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 26px 8px">${cuerpo}
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINEA};border-radius:8px;border-collapse:separate;margin:8px 0 16px;background:#FBFAF8">
      <tr><td colspan="${mora ? 6 : 5}" style="padding:12px 14px;font-size:10px;font-weight:bold;letter-spacing:1px;color:${GRIS}">DETALLE DE FACTURAS &middot; ${esc(empresa.toUpperCase())}</td></tr>
      <tr>${th('REFERENCIA')}${th('VENCIMIENTO')}${th('TIPO')}${th('MONTO', 'text-align:right')}${mora ? th('INTERÉS', 'text-align:right') : ''}${th('ESTADO', 'text-align:center')}</tr>
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
  `).then(() => console.log('Reclamos: tablas listas')).catch(e => console.error('Reclamos: error creando tablas', e.message));

  async function leerIPC() {
    const r = await pool.query(`SELECT value FROM config WHERE key='ipc'`);
    try { return r.rows[0] ? JSON.parse(r.rows[0].value) : {}; } catch { return {}; }
  }

  // Estado general
  app.get('/api/reclamos/estado', admin, async (req, res) => {
    try {
      const cuenta = await gmailCuenta(pool);
      const ipc = await leerIPC();
      const meses = Object.keys(ipc).sort();
      res.json({
        gmail: { conectado: !!cuenta?.refresh_token, email: cuenta?.email || null },
        colppy: { configurado: !!process.env.COLPPY_PASS },
        ipc: { meses: meses.length, ultimo: meses[meses.length - 1] || null },
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
      const ipc = await leerIPC();
      const crudas = await colppyFacturasPendientes();

      // Normalizar facturas
      const porCliente = new Map();
      for (const f of crudas) {
        const total = +f.totalFactura || 0;
        const saldo = r2(total - (+f.totalaplicado || 0));
        if (saldo <= 1) continue;
        const esAB = f.idTipoFactura === '0' || f.idTipoFactura === '1';
        const usd = esAB ? null : parseUSD(f.descripcion);
        const moneda = usd ? 'USD' : 'ARS';
        const importe = usd ? r2(usd * (total ? saldo / total : 1)) : saldo;
        const venc = String(f.fechaPago || f.fechaFactura).slice(0, 10);
        const diasVencida = Math.floor((Date.parse(hoy) - Date.parse(venc)) / 86400000);
        const pv = String(f.nroFactura || '').split('-')[0];
        const fac = {
          idFactura: f.idFactura, nro: f.nroFactura, letra: f.idTipoFactura === '0' ? 'A' : f.idTipoFactura === '1' ? 'B' : '',
          descripcion: f.descripcion, venc, diasVencida, moneda, importe, tieneCAE: !!f.cae, pv,
        };
        if (!porCliente.has(f.idCliente)) porCliente.set(f.idCliente, { idCliente: f.idCliente, empresa: (f.RazonSocial || f.NombreFantasia || '').trim(), facturas: [] });
        porCliente.get(f.idCliente).facturas.push(fac);
      }

      // Emails guardados
      const [ovr, facEm, cliEm] = await Promise.all([
        pool.query(`SELECT id_cliente, email FROM reclamos_contactos`),
        pool.query(`SELECT DISTINCT ON (lower(trim(empresa))) lower(trim(empresa)) k, email FROM facturas WHERE email <> '' ORDER BY lower(trim(empresa)), created_at DESC`),
        pool.query(`SELECT lower(trim(empresa)) k, email, contacto FROM clientes`),
      ]);
      const mOvr = new Map(ovr.rows.map(r => [r.id_cliente, r.email]));
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
        if (!facturas.length) continue;
        facturas.sort((a, b) => a.venc.localeCompare(b.venc));

        const totales = { ARS: 0, USD: 0 }, intereses = { ARS: 0, USD: 0 };
        let ipcIncompleto = false;
        for (const f of facturas) {
          totales[f.moneda] = r2(totales[f.moneda] + f.importe);
          if (tipoMail === 'mora') {
            const i = calcularIntereses(f.importe, f.venc, ipc, hoy);
            Object.assign(f, { meses: i.meses, interes: i.interes });
            intereses[f.moneda] = r2(intereses[f.moneda] + i.interes);
            if (i.usaFallback) ipcIncompleto = true;
          }
        }

        const k = claveEmpresa(c.empresa);
        const tieneUSD = totales.USD > 0;
        let email = [], origen = '';
        const candidatos = [
          ['editado', mOvr.get(c.idCliente)],
          ...(tieneUSD ? [['contacto USD', mFac.get(k)], ['clientes', mCli.get(k)]] : [['clientes', mCli.get(k)], ['facturas', mFac.get(k)]]),
        ];
        for (const [o, v] of candidatos) { const e = limpiarEmails(v); if (e.length) { email = e; origen = o; break; } }

        const sedes = [...new Set(facturas.map(f => sedeDePV(f.pv)).filter(Boolean))];
        const cc = [...new Set([...CC_FIJOS, ...sedes.map(s => s.cc)])];
        const problemas = [];
        if (facturas.some(f => !f.tieneCAE)) problemas.push('Hay facturas sin CAE: puede que no se adjunte su PDF');
        if (ipcIncompleto) problemas.push(`Faltan meses de IPC: se usa ${TASA_FALLBACK}% mensual`);
        if (yaEnviados.has(c.idCliente)) problemas.push(`Ya recibió un mail en las últimas ${HORAS_BLOQUEO_REENVIO} horas`);

        const mail = {
          idCliente: c.idCliente, empresa: c.empresa, contacto: mContacto.get(k) || '', email, emailOrigen: origen, cc,
          sedes: sedes.map(s => s.sede), tipoMail, asunto: TIPOS[tipoMail].asunto(c.empresa),
          facturas, totales, intereses, problemas, bloqueado: yaEnviados.has(c.idCliente),
        };
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
        enviables: mails.filter(m => m.email.length && !m.bloqueado).length,
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
      if (!to.length) return res.status(400).json({ error: `${m.empresa} no tiene email` });

      // Bloqueo de reenvío: mismo cliente en las últimas horas
      const rec = await pool.query(
        `SELECT 1 FROM reclamos_envios WHERE id_cliente=$1 AND estado='enviado' AND created_at > NOW() - ($2 || ' hours')::interval LIMIT 1`,
        [idCliente, String(HORAS_BLOQUEO_REENVIO)]);
      if (rec.rowCount) return res.json({ ok: true, omitido: true, motivo: 'Ya se le envió un mail recientemente' });

      // Reserva: un solo intento por cliente y lote (evita doble click o reintentos)
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

  // PDF de una factura (se descarga de Colppy en el momento)
  app.get('/api/reclamos/pdf', admin, async (req, res) => {
    try {
      const { idFactura, idCliente } = req.query;
      if (!/^\d+$/.test(idFactura || '') || !/^\d+$/.test(idCliente || '')) return res.status(400).json({ error: 'Factura inválida' });
      const buf = await colppyPdfFactura(idFactura, idCliente);
      if (!buf) return res.status(404).json({ error: 'Colppy no generó el PDF de esta factura (puede no tener CAE)' });
      res.set('Content-Type', 'application/pdf');
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

module.exports._test = { parseUSD, calcularIntereses, armarHtml, armarMime, limpiarEmails };
