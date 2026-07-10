-- =========================================================
-- FVRAM - Base de datos para Sistema de Farmacovigilancia RAM
-- Motor objetivo: MySQL 8+ / MariaDB 10.4+ (XAMPP)
-- =========================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS fvram
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE fvram;

-- =========================================================
-- Limpieza (para reprovisionar en desarrollo)
-- =========================================================
DROP TABLE IF EXISTS report_events;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS cat_services;
DROP TABLE IF EXISTS cat_report_status;

-- =========================================================
-- Catálogos
-- =========================================================
CREATE TABLE cat_report_status (
  id TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL,
  label VARCHAR(50) NOT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cat_report_status_code (code)
) ENGINE=InnoDB;

CREATE TABLE cat_services (
  id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(80) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cat_services_code (code),
  KEY idx_cat_services_active (is_active)
) ENGINE=InnoDB;

-- =========================================================
-- Usuarios (administración / dictamen)
-- =========================================================
CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(60) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role ENUM('admin','reviewer','capturista') NOT NULL DEFAULT 'reviewer',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_role_active (role, is_active)
) ENGINE=InnoDB;

-- =========================================================
-- Reportes RAM
-- =========================================================
CREATE TABLE reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  folio VARCHAR(20) NOT NULL,

  -- Datos del paciente
  patient_name VARCHAR(120) NOT NULL,
  patient_dob DATE NOT NULL,
  room VARCHAR(20) NOT NULL,

  -- Datos del evento
  suspected_drug VARCHAR(150) NOT NULL,
  reaction_date DATE NOT NULL,
  reaction_time TIME NOT NULL,
  reaction_description TEXT NOT NULL,

  -- Notificador
  reporter_name VARCHAR(120) NOT NULL,
  reporter_position VARCHAR(80) NOT NULL,

  -- Dictamen
  status_id TINYINT UNSIGNED NOT NULL,
  service_id SMALLINT UNSIGNED NULL,
  analysis TEXT NULL,
  rejection_reason VARCHAR(500) NULL,

  -- Trazabilidad
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by BIGINT UNSIGNED NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uk_reports_folio (folio),

  KEY idx_reports_status (status_id),
  KEY idx_reports_service (service_id),
  KEY idx_reports_submitted_at (submitted_at),
  KEY idx_reports_patient_name (patient_name),
  KEY idx_reports_suspected_drug (suspected_drug),

  CONSTRAINT fk_reports_status
    FOREIGN KEY (status_id) REFERENCES cat_report_status(id),
  CONSTRAINT fk_reports_service
    FOREIGN KEY (service_id) REFERENCES cat_services(id),
  CONSTRAINT fk_reports_reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES users(id),

  CONSTRAINT chk_reports_room_len
    CHECK (CHAR_LENGTH(room) BETWEEN 1 AND 20),
  CONSTRAINT chk_reports_dob_past
    CHECK (patient_dob <= CURRENT_DATE),
  CONSTRAINT chk_reports_reaction_not_future
    CHECK (reaction_date <= CURRENT_DATE)
) ENGINE=InnoDB;

-- Búsqueda en panel admin/tablero
-- Nota: si tu versión de MariaDB no soporta FULLTEXT en InnoDB, comenta estas 2 líneas.
ALTER TABLE reports ADD FULLTEXT KEY ft_reports_search (suspected_drug, reaction_description, analysis);
ALTER TABLE reports ADD FULLTEXT KEY ft_reports_patient (patient_name);

-- =========================================================
-- Bitácora / auditoría de cambios (quién cambió estado, análisis, etc.)
-- =========================================================
CREATE TABLE report_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  event_type ENUM('created','status_changed','analysis_updated','rejected','published','edited') NOT NULL,
  old_status_id TINYINT UNSIGNED NULL,
  new_status_id TINYINT UNSIGNED NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_events_report (report_id),
  KEY idx_report_events_actor (actor_user_id),
  KEY idx_report_events_type_date (event_type, created_at),
  CONSTRAINT fk_report_events_report
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
  CONSTRAINT fk_report_events_actor
    FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- =========================================================
-- Datos base (catálogos y usuario inicial)
-- =========================================================
INSERT INTO cat_report_status (id, code, label, is_public) VALUES
  (1, 'PENDIENTE', 'Pendiente', 0),
  (2, 'PUBLICADO', 'Publicado', 1),
  (3, 'RECHAZADO', 'Rechazado', 0);

INSERT INTO cat_services (id, code, name, is_active) VALUES
  (1, '1ER_NIVEL', '1er nivel', 1),
  (2, '2DO_NIVEL', '2do nivel', 1),
  (3, '3ER_NIVEL', '3er nivel', 1),
  (4, 'TERAPIA', 'terapia', 1),
  (5, 'URGENCIAS', 'urgencias', 1),
  (6, 'QUIROFANO', 'quirofano', 1);

-- Usuario inicial: user / 123
-- IMPORTANTE: este hash es solo para ambiente local de desarrollo.
-- Corresponde a bcrypt de '123' con costo 10.
INSERT INTO users (username, password_hash, full_name, role, is_active)
VALUES ('user', '$2y$10$qYBf6v2lJfM8kYwWkQ4g7e9Qn5Ay5A3U9m5cNl7G1X8nU6lWf7A2W', 'Administrador Inicial', 'admin', 1);

-- Reporte de ejemplo similar al frontend actual
INSERT INTO reports (
  folio,
  patient_name, patient_dob, room,
  suspected_drug, reaction_date, reaction_time, reaction_description,
  reporter_name, reporter_position,
  status_id, service_id, analysis, rejection_reason,
  submitted_at
) VALUES (
  '0126-001',
  'Juan Pérez Gómez', '1985-05-15', '402B',
  'Ceftriaxona 1g', '2023-10-25', '14:30:00',
  'El paciente presentó rash cutáneo y dificultad leve para respirar 15 minutos después de iniciada la infusión.',
  'Ana López', 'Enfermera',
  2, 2, 'Hipersensibilidad probable.', NULL,
  NOW()
);

INSERT INTO report_events (report_id, actor_user_id, event_type, new_status_id, notes)
SELECT r.id, u.id, 'published', 2, 'Carga inicial de ejemplo'
FROM reports r
JOIN users u ON u.username = 'user'
WHERE r.folio = '0126-001';

-- =========================================================
-- Vistas útiles para backend/API
-- =========================================================
DROP VIEW IF EXISTS v_public_board;
CREATE VIEW v_public_board AS
SELECT
  r.id,
  r.folio,
  r.suspected_drug,
  r.reaction_description,
  r.analysis,
  r.submitted_at,
  s.name AS service_name,
  -- anonimización simple: iniciales por palabra
  TRIM(
    REPLACE(
      REGEXP_REPLACE(r.patient_name, '([[:alpha:]])[[:alpha:]]*', '\\1.'),
      '  ',
      ' '
    )
  ) AS patient_initials
FROM reports r
JOIN cat_report_status st ON st.id = r.status_id
LEFT JOIN cat_services s ON s.id = r.service_id
WHERE st.code = 'PUBLICADO';

DROP VIEW IF EXISTS v_admin_report_list;
CREATE VIEW v_admin_report_list AS
SELECT
  r.id,
  r.folio,
  r.patient_name,
  r.room,
  r.suspected_drug,
  st.label AS status_label,
  s.name AS service_name,
  r.submitted_at,
  r.reviewed_at,
  u.full_name AS reviewed_by_name
FROM reports r
JOIN cat_report_status st ON st.id = r.status_id
LEFT JOIN cat_services s ON s.id = r.service_id
LEFT JOIN users u ON u.id = r.reviewed_by;

-- =========================================================
-- Sugerencias para backend PHP
-- =========================================================
-- 1) Insertar reporte nuevo con status_id = 1 (PENDIENTE).
-- 2) Para publicar: status_id = 2, service_id obligatorio, reviewed_by y reviewed_at.
-- 3) Para rechazar: status_id = 3, rejection_reason obligatorio.
-- 4) Registrar cada cambio relevante en report_events.
-- =========================================================
