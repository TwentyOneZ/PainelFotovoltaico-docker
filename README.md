# Painel Fotovoltaico — Backend (Docker)

Backend em Node.js que recebe as medições do ESP32 unificado (painel gerador +
célula de referência + sensores ambientais), grava no MySQL, confirma cada lote
para o ESP32 (ACK), calcula a potência esperada pelo modelo do painel, alimenta o
dashboard (histórico e Live View), repassa o estado ao gêmeo digital no Ditto e
envia alertas pelo WhatsApp.

O firmware fica no repositório
[Painel-Fotovoltaico](https://github.com/EMCCERISE/Painel-Fotovoltaico) (README com
a pinagem e a ligação dos sensores).

## Arquitetura

```
ESP32 ──painelfv/<dev>/data──► MQTT (cerise:30001) ──► backend ──INSERT IGNORE──► MySQL
  ▲                                                       │
  └──────────painelfv/<dev>/ack (após o COMMIT)───────────┤
  └──────────painelfv/<dev>/cmd (live, iscRef, ...)───────┤
                                                          ├──► Ditto (tópicos legados, só dados recentes)
                                                          ├──► Dashboard (HTTP :4000, SSE /api/live)
                                                          └──► WhatsApp (alertas e comandos)
```

- **Uma linha por registro do ESP32**, com `ts` = horário da medição (NTP no ESP32).
  Dados que ficaram no buffer do ESP32 durante uma queda chegam depois e entram no
  lugar certo da série temporal.
- **Sem duplicatas**: `(device_id, boot_id, seq)` é chave única; reenvios (ACK
  perdido) são ignorados pelo `INSERT IGNORE` e confirmados de novo.
- **Decimação**: registros com `samples > 1` são médias de N segundos feitas pelo
  ESP32 quando o buffer encheu; as agregações do dashboard ponderam por `samples`.
- **Falha** (`falha`, `tipo_falha`): derivada pelo trigger a partir de
  `fault_intervals`, pelo horário da própria medição.
- **Estimativas** (`estimatedPower`, `expectedLoadVoltage`, ...): calculadas por
  registro com o modelo do painel (`config.ini` → `[pv]`) e a carga resistiva.

## Grandezas gravadas (SI)

| Coluna | Unidade | Origem |
|---|---|---|
| `voltage`, `current_A`, `power_W` | V, A, W | INA226 do gerador (P = média de V × I) |
| `current_ref_A`, `irradiance` | A, W/m² | INA226 da célula de referência (G = I/iscRef × 1000) |
| `lux`, `visible`, `infrared` | lx, contagens | TSL2591 |
| `temperature`, `humidity` | °C, % | AHT20 |
| `temperature_bmp`, `pressure_Pa` | °C, Pa | BMP280 |
| `gpio23` | 0/1 | estado do relé |
| `samples` | — | nº de amostras de 1 s agregadas no registro |
| `received_at` | — | quando o backend recebeu |
| `time_estimated` | 0/1 | horário restaurado após reset (antes do NTP) |

As colunas antigas `current_mA`/`power_mW` foram renomeadas (os valores já eram
gravados em A/W). Veja `migrations/003_unified_esp32.sql`; a migração é aplicada
automaticamente na inicialização.

## Robustez

- **Health check** `GET /api/health`: testa o MySQL (timeout de 3 s) e o MQTT. O
  `healthcheck` do `docker-compose.yml` marca o container como *unhealthy* após
  ~2 min de falha e o `scripts/healthwatch.sh` (cron na VPS, a cada minuto)
  reinicia o backend. Falta de dados do ESP32 não derruba o health.
- **Timeouts** em todas as consultas e fila de conexões limitada (nada prende o
  pool para sempre); CSV gerado em *streaming*.
- **WhatsApp** com uma única sessão e reconexão com backoff.
- **Logs** com rotação (3 × 10 MB por container).
- Reiniciar o backend **não perde dados**: o ESP32 guarda as medições na flash e
  reenvia o que não recebeu ACK.

## Alertas no WhatsApp

Enviados ao número de `ALERT_WHATSAPP_NUMBER` (o próprio número conectado ao bot):

- **Painel sem receber dados** há 10 min, 1 h, 3 h, 6 h, 12 h e depois a cada 24 h.
- **Conexão restabelecida** quando os dados voltam.

O estado fica em `/data/whatsapp-alert-state.json` (reinícios não repetem alertas).
Comandos aceitos: `#status`, `#limpezaon`, `#limpezaoff`.

Para conectar/reconectar o WhatsApp, abra `http://<servidor>:4000/qr` e escaneie em
*WhatsApp → Dispositivos conectados → Conectar dispositivo*.

## API

| Rota | Descrição |
|---|---|
| `GET /api/health` | saúde do backend (db, mqtt, whatsapp, idade do último dado) |
| `GET /api/readings?metric=&start=&end=&maxPoints=` | série temporal (agregada se passar de `maxPoints`) |
| `GET /api/download?start=&end=` | CSV completo (streaming) |
| `GET /api/live` | Live View por SSE; enquanto houver cliente, o ESP32 envia a cada 1 s |
| `GET /api/live-cache?since=` | lacunas do Live View |
| `GET/POST /api/pv-config` | parâmetros do modelo do painel e `iscRef` (repassado ao ESP32) |
| `GET /api/device-status` | último status de cada ESP32 (buffer, sensores, rede, parâmetros) |
| `POST /api/device-config` | `{device?, iscRef?, interval?, panelParams?, status?}` → comando ao ESP32 |
| `GET/POST /api/falha`, `/api/falha/timed` | injeção de falha (manual e temporizada) |
| `GET /qr` | pareamento do WhatsApp |

## Instalação / atualização

```bash
cp .env.example .env        # senhas do MySQL e do MQTT, número dos alertas
docker compose up -d --build
# vigia do health (uma vez, na VPS):
chmod +x scripts/healthwatch.sh
(crontab -l 2>/dev/null; echo "* * * * * $PWD/scripts/healthwatch.sh") | crontab -
```

- `.env` é ignorado pelo git; o `config.ini` não contém senhas.
- O MySQL fica acessível apenas em `127.0.0.1:3307` na VPS.
- Na VPS, o `config.ini` guarda parâmetros PV ajustados pelo dashboard: não o
  sobrescreva com o do repositório.
- Faça backup antes de atualizar:
  `docker exec painel-mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases painelSolar' | gzip > backup.sql.gz`
