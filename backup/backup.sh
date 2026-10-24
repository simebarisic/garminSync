#!/bin/sh
# Dnevni pg_dump garmin baze u /backups (mapirano na ./backups na hostu).
# Custom format (-Fc) – vraćanje:  pg_restore -d garmin --clean --if-exists <file>
set -eu

: "${BACKUP_TIME:=03:15}"
: "${BACKUP_KEEP_DAYS:=14}"
: "${BACKUP_DIR:=/backups}"

log() { echo "[backup $(date '+%F %T')] $*"; }

backup() {
  f="$BACKUP_DIR/garmin-$(date +%F_%H%M).dump"
  if pg_dump -Fc -f "$f.tmp"; then
    mv "$f.tmp" "$f"
    log "ok $(basename "$f") ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.tmp"
    log "GREŠKA – pg_dump nije uspio" >&2
  fi
  # rotacija: obriši starije od BACKUP_KEEP_DAYS dana
  find "$BACKUP_DIR" -maxdepth 1 -name 'garmin-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -exec rm -f {} \; -exec echo "[backup] obrisan stari {}" \;
}

until pg_isready -q; do sleep 2; done
log "spreman – dnevno u $BACKUP_TIME, čuvam $BACKUP_KEEP_DAYS dana"

# ručni backup:  docker compose run --rm backup --once
[ "${1:-}" = "--once" ] && { backup; exit 0; }

# odmah prvi backup ako ga nema
ls "$BACKUP_DIR"/garmin-*.dump >/dev/null 2>&1 || backup

last=""
while true; do
  if [ "$(date +%H:%M)" = "$BACKUP_TIME" ] && [ "$last" != "$(date +%F)" ]; then
    backup
    last="$(date +%F)"
  fi
  sleep 30
done
