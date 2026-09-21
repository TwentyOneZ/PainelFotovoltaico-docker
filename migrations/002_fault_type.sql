-- 002_fault_type.sql
-- Adds a human-readable fault type to each 1 Hz reading where falha = 1.
-- The backend applies the same migration automatically at startup.

ALTER TABLE readings
  ADD COLUMN tipo_falha VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS fault_intervals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  tipo_falha VARCHAR(255) NULL,
  INDEX idx_fault_intervals_started (started_at),
  INDEX idx_fault_intervals_window (started_at, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS trg_readings_tipo_falha_bi;

CREATE TRIGGER trg_readings_tipo_falha_bi
BEFORE INSERT ON readings
FOR EACH ROW
BEGIN
  IF NEW.falha = 1 THEN
    SET NEW.tipo_falha = (
      SELECT fi.tipo_falha
      FROM fault_intervals fi
      WHERE NEW.ts >= fi.started_at
        AND (fi.ended_at IS NULL OR NEW.ts < fi.ended_at)
      ORDER BY fi.started_at DESC
      LIMIT 1
    );
  ELSE
    SET NEW.tipo_falha = NULL;
  END IF;
END;
