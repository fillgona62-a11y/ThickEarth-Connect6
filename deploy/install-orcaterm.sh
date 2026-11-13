#!/usr/bin/env bash
# One-shot installer for a fresh OpenCloudOS 9 / RHEL-family host with no domain.
# Paste the whole file into OrcaTerm (or: bash install-orcaterm.sh).
# Idempotent: safe to run again after a failed attempt.
set -euo pipefail

APP_USER=thickearth
APP_DIR=/opt/thickearth
DATA_DIR=/var/lib/thickearth
REPO=https://github.com/fillgona62-a11y/ThickEarth-Connect6.git

# Detect the public address automatically; override with PUBLIC_ORIGIN=http://x.x.x.x
PUBLIC_IP=$(curl -fsS --max-time 4 ifconfig.me 2>/dev/null || true)
ORIGIN="${PUBLIC_ORIGIN:-http://${PUBLIC_IP:-127.0.0.1}}"

log() { printf '\n==> %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (OrcaTerm usually is)."; exit 1; }

log "Node 22"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
  [ "$MAJOR" -ge 22 ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi
NODE_BIN=$(command -v node)
"$NODE_BIN" -v

log "nginx"
command -v nginx >/dev/null 2>&1 || dnf install -y nginx

log "Service account and data directory"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"

log "Source code"
if [ -f "$APP_DIR/server/index.js" ]; then
  git -C "$APP_DIR" pull --ff-only 2>/dev/null || echo "(already present, keeping local copy)"
elif [ -f /root/thickearth-deploy.tar.gz ]; then
  mkdir -p "$APP_DIR"
  tar -xzf /root/thickearth-deploy.tar.gz -C "$APP_DIR" --strip-components=1
  echo "unpacked /root/thickearth-deploy.tar.gz"
else
  git clone "$REPO" "$APP_DIR" || {
    echo
    echo "git clone failed. Upload the source tarball with OrcaTerm's file"
    echo "transfer as /root/thickearth-deploy.tar.gz, then run this script again."
    exit 1
  }
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

log "systemd unit"
sed -e "s|http://YOUR_SERVER_IP|${ORIGIN}|g" \
    -e "s|ExecStart=/usr/bin/node|ExecStart=${NODE_BIN}|" \
    "$APP_DIR/deploy/thickearth-http.service" > /etc/systemd/system/thickearth.service
grep -E 'PUBLIC_ORIGIN|ExecStart' /etc/systemd/system/thickearth.service

log "nginx config"
# Move the distro's default site out of the way so port 80 is ours.
[ -f /etc/nginx/conf.d/default.conf ] && \
  mv -f /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled-thickearth
cp -n /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-thickearth 2>/dev/null || true
if grep -qE 'listen[[:space:]]+80[[:space:]]+default_server' /etc/nginx/nginx.conf; then
  sed -i -e 's/listen[[:space:]]\+80 default_server;/listen 8081 default_server;/' \
         -e 's/listen[[:space:]]\+\[::\]:80 default_server;/listen [::]:8081 default_server;/' \
         /etc/nginx/nginx.conf
fi
cp "$APP_DIR/deploy/nginx-http.conf" /etc/nginx/conf.d/thickearth.conf

log "Firewall and SELinux"
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --reload >/dev/null
fi
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  if command -v setsebool >/dev/null 2>&1; then
    setsebool -P httpd_can_network_connect 1
  else
    dnf install -y policycoreutils-python-utils >/dev/null
    setsebool -P httpd_can_network_connect 1
  fi
fi

log "Start services"
systemctl daemon-reload
systemctl enable --now thickearth
systemctl enable --now nginx
nginx -t
systemctl reload nginx
sleep 2

log "Self check"
curl -fsS http://127.0.0.1/api/config || {
  echo "reverse proxy check failed; testing the app directly"
  curl -fsS http://127.0.0.1:8080/api/config
  systemctl status thickearth --no-pager | tail -20
}

printf '\nDone. Open %s in a browser.\n' "$ORIGIN"
echo "Register an account, then open Settings and enter the AI provider again"
echo "(AI settings are per-user and are not copied from your PC)."
