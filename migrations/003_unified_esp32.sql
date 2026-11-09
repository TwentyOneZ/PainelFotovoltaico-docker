-- 003_unified_esp32.sql
-- ESP32 unificado (Gerador + Referencia) com buffer em flash e ACK.
-- O backend aplica esta migracao automaticamente na inicializacao (server-v2.js
-- e server-entry.js); este arquivo documenta o que muda.

-- 1) Nomes em SI. Os valores ja eram gravados em A e W desde o firmware que
--    passou a converter mA -> A; apenas o nome da coluna estava errado.
--    ATENCAO: linhas gravadas por firmwares muito antigos (main.cpp.old) podem
--    estar em mA/mW. Se for o caso, converta-as manualmente por data, ex.:
--      UPDATE readings SET current_A = current_A / 1000, power_W = power_W / 1000
--      WHERE ts < '<data da troca de firmware>';
ALTER TABLE readings CHANGE COLUMN current_mA current_A DOUBLE NULL;
ALTER TABLE readings CHANGE COLUMN power_mW   power_W   DOUBLE NULL;

-- 2) Uma linha por registro do ESP32, com o horario da medicao em ts.
ALTER TABLE readings
  ADD COLUMN device_id       VARCHAR(32)       NULL,
  ADD COLUMN boot_id         SMALLINT UNSIGNED NULL,
  ADD COLUMN seq             INT UNSIGNED      NULL,
  ADD COLUMN samples         SMALLINT UNSIGNED NULL,  -- >1: media de N s (decimacao no ESP32)
  ADD COLUMN received_at     DATETIME(3)       NULL,  -- quando o backend recebeu
  ADD COLUMN current_ref_A   DOUBLE            NULL,  -- corrente bruta da celula de referencia
  ADD COLUMN visible         INT               NULL,
  ADD COLUMN infrared        INT               NULL,
  ADD COLUMN temperature_bmp DOUBLE            NULL,
  ADD COLUMN pressure_Pa     DOUBLE            NULL,
  ADD COLUMN gpio23          TINYINT(1)        NULL,
  ADD COLUMN time_estimated  TINYINT(1)        NULL;  -- horario restaurado apos reset

-- 3) Deduplicacao: reenvios do ESP32 (ACK perdido) sao ignorados (INSERT IGNORE).
CREATE UNIQUE INDEX uq_readings_device_boot_seq ON readings (device_id, boot_id, seq);

-- 4) falha/tipo_falha passam a ser derivados de fault_intervals pelo ts da
--    propria medicao (dados enviados com atraso recebem o estado correto).
--    Ver trigger trg_readings_tipo_falha_bi em server-entry.js.
