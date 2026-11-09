#!/bin/sh
# Reinicia o backend quando o healthcheck do Docker o marca como "unhealthy".
# (O Docker sozinho só marca; não reinicia containers unhealthy.)
#
# Instalação na VPS (cron do usuário, a cada minuto):
#   chmod +x ~/PainelFotovoltaico-docker/scripts/healthwatch.sh
#   (crontab -l 2>/dev/null; echo '* * * * * ~/PainelFotovoltaico-docker/scripts/healthwatch.sh') | crontab -
#
# Histórico de reinícios: journalctl -t painel-healthwatch   (ou grep painel-healthwatch /var/log/syslog)

CONTAINER=painel-solar-app
STATUS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER" 2>/dev/null)

if [ "$STATUS" = "unhealthy" ]; then
  LAST=$(docker inspect -f '{{range .State.Health.Log}}{{.Output}}{{end}}' "$CONTAINER" 2>/dev/null | tail -c 300)
  logger -t painel-healthwatch "backend unhealthy, reiniciando. Ultima verificacao: $LAST"
  docker restart "$CONTAINER" >/dev/null 2>&1
fi
