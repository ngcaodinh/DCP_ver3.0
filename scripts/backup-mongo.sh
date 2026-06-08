#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/dcp/backups/mongo"
BACKUP_FILE="${BACKUP_DIR}/dcp-$(date +%Y%m%d-%H%M%S).archive"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

docker exec dcp-mongo mongodump \
  --username root \
  --password "${MONGO_ROOT_PASSWORD}" \
  --authenticationDatabase admin \
  --archive=/tmp/dcp-backup.archive \
  --gzip

docker cp dcp-mongo:/tmp/dcp-backup.archive "${BACKUP_FILE}"
docker exec dcp-mongo rm -f /tmp/dcp-backup.archive

find "${BACKUP_DIR}" -name 'dcp-*.archive' -type f -mtime +"${RETENTION_DAYS}" -delete

echo "MongoDB backup created: ${BACKUP_FILE}"
