#!/usr/bin/env bash
# Installs/updates the status exporter on the Oracle box. Run as ubuntu (uses sudo).
# Usage (from repo root on the Windows VM):
#   scp -i ~/.ssh/oracle_binokel -r exporter ubuntu@89.168.70.227:/tmp/status-exporter
#   ssh -i ~/.ssh/oracle_binokel ubuntu@89.168.70.227 'bash /tmp/status-exporter/install.sh'
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
command -v vnstat >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q vnstat
sudo install -d -m 755 /opt/status-exporter /etc/status-exporter
sudo install -m 644 "$src/exporter.ts" /opt/status-exporter/exporter.ts
# keep a locally edited config unless --config is given
if [ ! -f /etc/status-exporter/config.json ] || [ "${1:-}" = "--config" ]; then
  sudo install -m 644 "$src/config.json" /etc/status-exporter/config.json
fi
sudo install -m 644 "$src/status-exporter.service" /etc/systemd/system/status-exporter.service
sudo systemctl daemon-reload
sudo systemctl enable status-exporter.service >/dev/null
sudo systemctl restart status-exporter.service
sleep 1
curl -fsS http://127.0.0.1:8799/status.json | head -c 400; echo
