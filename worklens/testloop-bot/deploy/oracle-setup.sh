#!/usr/bin/env bash
# One-time (and re-runnable) setup of the TestLoop bot on an Oracle Cloud Always Free Ubuntu VM.
# Expects the bot files (including .env) already copied to ~/testloop-bot. Installs Node 22 and
# Caddy, runs the bot as a systemd service, and serves it over HTTPS at <ip>.sslip.io so WorkLens
# can connect without you buying a domain.
set -euo pipefail

SRC="$HOME/testloop-bot"
APP=/opt/testloop
DATA=/var/lib/testloop
[ -f "$SRC/bot.js" ] || { echo "Copy the bot to $SRC first."; exit 1; }
[ -f "$SRC/.env" ] || { echo "Missing $SRC/.env"; exit 1; }

echo "==> Packages"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "==> Bot files"
sudo id testloop >/dev/null 2>&1 || sudo useradd --system --home "$DATA" --shell /usr/sbin/nologin testloop
sudo mkdir -p "$APP" "$DATA"
sudo cp -r "$SRC"/. "$APP"/
# Data lives outside the app folder so redeploys never touch it.
sudo sed -i -e '/^DATA_DIR=/d' -e '/^PORT=/d' "$APP/.env"
printf 'DATA_DIR=%s\nPORT=3000\n' "$DATA" | sudo tee -a "$APP/.env" >/dev/null
sudo chown -R testloop:testloop "$APP" "$DATA"
sudo chmod 600 "$APP/.env"

echo "==> Service"
sudo tee /etc/systemd/system/testloop.service >/dev/null <<EOF
[Unit]
Description=TestLoop Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
User=testloop
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable testloop
sudo systemctl restart testloop

echo "==> HTTPS"
# Oracle's Ubuntu images ship iptables rules that reject everything but SSH; open 80/443.
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport $port -j ACCEPT
done
sudo netfilter-persistent save
IP=$(curl -fsS https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$HOST {
  reverse_proxy localhost:3000
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy

sleep 5
echo
systemctl --no-pager --lines=5 status testloop || true
echo
echo "Bot URL for WorkLens:  https://$HOST"
echo "Check:                 curl https://$HOST/health"
echo "Logs:                  sudo journalctl -u testloop -f"
