'use strict';

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const express = require('express');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'fvram-db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'fvram_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'fvram',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
  dateStrings: true
});

const adminPassword = process.env.ADMIN_PASSWORD || '';
const smtpUser = process.env.SMTP_USER || '';
const smtpPassword = process.env.SMTP_PASSWORD || '';
const reportRecipient = process.env.REPORT_EMAIL_TO || '';
const smtpTlsFingerprint = String(process.env.SMTP_TLS_FINGERPRINT256 || '').toUpperCase();
let pinnedSocketFactory = null;
const smtpTransportOptions = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true') === 'true',
  auth: { user: smtpUser, pass: smtpPassword }
};
if (smtpTlsFingerprint) {
  pinnedSocketFactory = (options, callback) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      callback(error, value);
    };
    const validateTlsSocket = socket => {
      const certificate = socket.getPeerCertificate();
      const fingerprintMatches = certificate && String(certificate.fingerprint256).toUpperCase() === smtpTlsFingerprint;
      if (!socket.authorized && !fingerprintMatches) {
        socket.destroy();
        finish(new Error('La huella del certificado SMTP no coincide.'));
        return;
      }
      finish(null, { connection: socket, secured: true });
    };
    if (smtpTransportOptions.secure) {
      const socket = tls.connect({ host: options.host, port: options.port, servername: options.host, rejectUnauthorized: false });
      socket.once('secureConnect', () => validateTlsSocket(socket));
      socket.once('error', finish);
      return;
    }

    const plainSocket = net.connect(options.port, options.host);
    let stage = 'greeting';
    let response = '';
    plainSocket.setEncoding('utf8');
    plainSocket.setTimeout(15_000, () => finish(new Error('Tiempo agotado al negociar STARTTLS.')));
    plainSocket.once('error', finish);
    plainSocket.on('data', chunk => {
      response += chunk;
      if (stage === 'greeting' && /^220[ -]/.test(response)) {
        response = '';
        stage = 'ehlo';
        plainSocket.write('EHLO fvram.local\r\n');
      } else if (stage === 'ehlo' && /(?:^|\r\n)250 [^\r\n]*\r\n$/.test(response)) {
        if (!/(?:^|\r\n)250[ -]STARTTLS(?:\r\n|$)/.test(response)) {
          finish(new Error('El servidor SMTP no ofrece STARTTLS.'));
          plainSocket.destroy();
          return;
        }
        response = '';
        stage = 'starttls';
        plainSocket.write('STARTTLS\r\n');
      } else if (stage === 'starttls' && /^220[ -]/.test(response)) {
        plainSocket.removeAllListeners('data');
        plainSocket.setTimeout(0);
        const secureSocket = tls.connect({ socket: plainSocket, servername: options.host, rejectUnauthorized: false });
        secureSocket.once('secureConnect', () => validateTlsSocket(secureSocket));
        secureSocket.once('error', finish);
      }
    });
  };
}
const mailer = smtpUser && smtpPassword ? nodemailer.createTransport(smtpTransportOptions) : null;
if (mailer && pinnedSocketFactory) mailer.getSocket = pinnedSocketFactory;
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function clean(value, max) {
  return String(value ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req).fvram_session;
  const expiresAt = token && sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Sesión administrativa requerida.' });
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  next();
}

function mapReport(row) {
  return {
    id: row.folio,
    patientName: row.patient_name,
    dob: row.patient_dob,
    room: row.room,
    drug: row.suspected_drug,
    reactionDate: row.reaction_date,
    reactionTime: row.reaction_time ? String(row.reaction_time).slice(0, 5) : '',
    description: row.reaction_description,
    reporterName: row.reporter_name,
    reporterPosition: row.reporter_position,
    timestamp: `${String(row.submitted_at).replace(' ', 'T')}Z`,
    status: row.status_label,
    service: row.service_name || '',
    analysis: row.analysis || '',
    rejectionReason: row.rejection_reason || ''
  };
}

const reportSelect = `
  SELECT r.*, st.label AS status_label, s.name AS service_name
  FROM reports r
  JOIN cat_report_status st ON st.id = r.status_id
  LEFT JOIN cat_services s ON s.id = r.service_id`;

function validateNewReport(body) {
  const data = {
    patientName: clean(body.patientName, 120), dob: clean(body.dob, 10), room: clean(body.room, 20).toUpperCase(),
    drug: clean(body.drug, 150), reactionDate: clean(body.reactionDate, 10), reactionTime: clean(body.reactionTime, 8),
    description: clean(body.description, 1200), reporterName: clean(body.reporterName, 120), reporterPosition: clean(body.reporterPosition, 80)
  };
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  const namePattern = /^[A-Za-zÁÉÍÓÚáéíóúÑñÜü'.,\-\s]+$/;
  const today = new Date().toISOString().slice(0, 10);
  if (data.patientName.length < 5 || !namePattern.test(data.patientName)) throw new Error('Nombre de paciente inválido.');
  if (data.reporterName.length < 5 || !namePattern.test(data.reporterName)) throw new Error('Nombre del notificador inválido.');
  if (!/^[A-Za-z0-9\-/]{1,20}$/.test(data.room)) throw new Error('Habitación inválida.');
  if (data.drug.length < 2 || data.description.length < 20 || data.reporterPosition.length < 3) throw new Error('Faltan datos obligatorios.');
  if (!datePattern.test(data.dob) || !datePattern.test(data.reactionDate) || data.dob > today || data.reactionDate > today || data.reactionDate < data.dob) throw new Error('Fechas inválidas.');
  if (data.reactionTime && !timePattern.test(data.reactionTime)) throw new Error('Hora inválida.');
  return data;
}

function reportEmailContent(report) {
  const value = v => String(v || 'No especificada');
  const lines = [
    `Folio: ${value(report.folio)}`,
    `Paciente: ${value(report.patientName)}`,
    `Fecha de nacimiento: ${value(report.dob)}`,
    `Habitación: ${value(report.room)}`,
    `Medicamento sospechoso: ${value(report.drug)}`,
    `Fecha de la reacción: ${value(report.reactionDate)}`,
    `Hora de la reacción: ${value(report.reactionTime)}`,
    `Descripción: ${value(report.description)}`,
    `Nombre de quien reporta: ${value(report.reporterName)}`,
    `Puesto: ${value(report.reporterPosition)}`,
    `Fecha de envío: ${value(report.timestamp)}`,
    'Estado: Pendiente'
  ];
  return lines.join('\n');
}

async function sendPendingNotification(notificationId, report) {
  if (!mailer || !reportRecipient) throw new Error('SMTP no configurado.');
  await mailer.sendMail({
    from: `Farmacovigilancia RAM <${smtpUser}>`,
    to: reportRecipient,
    subject: `Nuevo reporte RAM - ${report.folio}`,
    text: reportEmailContent(report)
  });
  await pool.execute("UPDATE email_notifications SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = ?", [notificationId]);
}

async function processEmailQueue() {
  const [rows] = await pool.query(`SELECT n.id AS notification_id, r.folio, r.patient_name, r.patient_dob, r.room,
    r.suspected_drug, r.reaction_date, r.reaction_time, r.reaction_description, r.reporter_name,
    r.reporter_position, r.submitted_at
    FROM email_notifications n JOIN reports r ON r.id = n.report_id
    WHERE n.status = 'pending' AND n.next_attempt_at <= NOW() ORDER BY n.id LIMIT 10`);
  for (const row of rows) {
    const report = {
      folio: row.folio, patientName: row.patient_name, dob: row.patient_dob, room: row.room,
      drug: row.suspected_drug, reactionDate: row.reaction_date, reactionTime: row.reaction_time,
      description: row.reaction_description, reporterName: row.reporter_name,
      reporterPosition: row.reporter_position, timestamp: row.submitted_at
    };
    try {
      await sendPendingNotification(row.notification_id, report);
    } catch (error) {
      await pool.execute(`UPDATE email_notifications SET attempts = attempts + 1, last_error = ?,
        next_attempt_at = DATE_ADD(NOW(), INTERVAL LEAST(60, POW(2, attempts + 1)) MINUTE) WHERE id = ?`,
        [String(error.message || error).slice(0, 500), row.notification_id]);
      console.error(`Email notification ${row.notification_id} failed:`, error.message);
    }
  }
}

async function initializeDatabase() {
  await pool.query('ALTER TABLE reports MODIFY reaction_time TIME NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS email_notifications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    report_id BIGINT UNSIGNED NOT NULL,
    status ENUM('pending','sent') NOT NULL DEFAULT 'pending',
    attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NULL,
    next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uk_email_report (report_id), KEY idx_email_pending (status, next_attempt_at),
    CONSTRAINT fk_email_report FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.post('/reports', async (req, res, next) => {
  let connection;
  try {
    const data = validateNewReport(req.body);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.query("SELECT GET_LOCK('fvram_folio', 10)");
    const yy = String(new Date().getUTCFullYear()).slice(-2);
    const mm = String(new Date().getUTCMonth() + 1).padStart(2, '0');
    const [numberRows] = await connection.query("SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(folio, '-', -1) AS UNSIGNED)), 0) + 1 AS next_number FROM reports WHERE SUBSTRING(folio, 3, 2) = ?", [yy]);
    const folio = `${mm}${yy}-${String(numberRows[0].next_number).padStart(3, '0')}`;
    const [result] = await connection.execute(`INSERT INTO reports
      (folio, patient_name, patient_dob, room, suspected_drug, reaction_date, reaction_time, reaction_description, reporter_name, reporter_position, status_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [folio, data.patientName, data.dob, data.room, data.drug, data.reactionDate, data.reactionTime || null, data.description, data.reporterName, data.reporterPosition]);
    await connection.execute("INSERT INTO report_events (report_id, event_type, new_status_id, notes) VALUES (?, 'created', 1, 'Reporte recibido desde formulario web')", [result.insertId]);
    const [notification] = await connection.execute('INSERT INTO email_notifications (report_id) VALUES (?)', [result.insertId]);
    await connection.commit();
    await sendPendingNotification(notification.insertId, { folio, ...data, timestamp: new Date().toISOString() }).catch(error => {
      console.error(`Initial email for ${folio} failed; it remains queued:`, error.message);
    });
    res.status(201).json({ folio });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.message && !error.code) return res.status(400).json({ error: error.message });
    next(error);
  } finally {
    if (connection) {
      await connection.query("SELECT RELEASE_LOCK('fvram_folio')").catch(() => {});
      connection.release();
    }
  }
});

app.get('/reports/public', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`${reportSelect} WHERE st.code = 'PUBLICADO' ORDER BY r.submitted_at DESC`);
    res.json(rows.map(mapReport));
  } catch (error) { next(error); }
});

app.post('/admin/login', (req, res) => {
  const supplied = String(req.body.password || '');
  const valid = adminPassword && supplied.length === adminPassword.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(adminPassword));
  if (!valid) return res.status(401).json({ error: 'Clave incorrecta.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `fvram_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  const token = parseCookies(req).fvram_session;
  sessions.delete(token);
  res.setHeader('Set-Cookie', 'fvram_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/admin/reports', requireAdmin, async (_req, res, next) => {
  try { const [rows] = await pool.query(`${reportSelect} ORDER BY r.submitted_at DESC`); res.json(rows.map(mapReport)); }
  catch (error) { next(error); }
});

app.post('/admin/import', requireAdmin, async (req, res, next) => {
  const incoming = Array.isArray(req.body.reports) ? req.body.reports.slice(0, 500) : [];
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    let imported = 0;
    let skipped = 0;
    for (const item of incoming) {
      try {
        if (item.id === '0126-001' || !/^\d{4}-\d{3,}$/.test(String(item.id || ''))) { skipped++; continue; }
        const data = validateNewReport(item);
        const status = ['Pendiente', 'Publicado', 'Rechazado'].includes(item.status) ? item.status : 'Pendiente';
        const service = clean(item.service, 80);
        const analysis = clean(item.analysis, 5000);
        const rejection = clean(item.rejectionReason, 500);
        const submittedAt = /^\d{4}-\d{2}-\d{2}T/.test(String(item.timestamp || ''))
          ? String(item.timestamp).slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
        const [statusRows] = await connection.execute('SELECT id FROM cat_report_status WHERE label = ?', [status]);
        const [serviceRows] = service ? await connection.execute('SELECT id FROM cat_services WHERE name = ? AND is_active = 1', [service]) : [[]];
        if (status === 'Publicado' && !serviceRows.length) { skipped++; continue; }
        const [result] = await connection.execute(`INSERT IGNORE INTO reports
          (folio, patient_name, patient_dob, room, suspected_drug, reaction_date, reaction_time, reaction_description,
           reporter_name, reporter_position, status_id, service_id, analysis, rejection_reason, submitted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, data.patientName, data.dob, data.room, data.drug, data.reactionDate, data.reactionTime, data.description,
           data.reporterName, data.reporterPosition, statusRows[0].id, serviceRows[0]?.id || null, analysis,
           status === 'Rechazado' ? rejection : null, submittedAt]);
        if (result.affectedRows) {
          imported++;
          await connection.execute("INSERT INTO report_events (report_id, event_type, new_status_id, notes) VALUES (?, 'created', ?, 'Importado desde almacenamiento local')", [result.insertId, statusRows[0].id]);
        } else skipped++;
      } catch { skipped++; }
    }
    await connection.commit();
    res.json({ imported, skipped });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally { if (connection) connection.release(); }
});

app.put('/admin/reports/:folio', requireAdmin, async (req, res, next) => {
  try {
    const status = clean(req.body.status, 20);
    const service = clean(req.body.service, 80);
    const analysis = clean(req.body.analysis, 5000);
    const rejection = clean(req.body.rejectionReason, 500);
    if (!['Pendiente', 'Publicado', 'Rechazado'].includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
    if (status === 'Publicado' && !service) return res.status(400).json({ error: 'Debes asignar un servicio.' });
    if (status === 'Rechazado' && rejection.length < 8) return res.status(400).json({ error: 'El motivo debe tener al menos 8 caracteres.' });
    const [result] = await pool.execute(`UPDATE reports r
      JOIN cat_report_status st ON st.label = ?
      LEFT JOIN cat_services s ON s.name = ? AND s.is_active = 1
      SET r.status_id = st.id, r.service_id = CASE WHEN ? = '' THEN NULL ELSE s.id END,
          r.analysis = ?, r.rejection_reason = CASE WHEN ? = 'Rechazado' THEN ? ELSE NULL END,
          r.reviewed_at = NOW()
      WHERE r.folio = ? AND (? = '' OR s.id IS NOT NULL)`, [status, service, service, analysis, status, rejection, req.params.folio, service]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Reporte o servicio no encontrado.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'No fue posible completar la operación.' });
});

async function start() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try { await initializeDatabase(); break; }
    catch (error) {
      if (attempt === 30) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  setInterval(() => processEmailQueue().catch(console.error), 60_000).unref();
  processEmailQueue().catch(console.error);
  app.listen(3000, '0.0.0.0', () => console.log('FVRAM API listening on port 3000'));
}

start().catch(error => { console.error(error); process.exit(1); });
