#!/usr/bin/env bash
# Turn an install-orcaterm.sh HTTP deployment into HTTPS.
# Usage: DOMAIN=example.com bash /root/enable-https.sh
#
# Requires: the A record already resolves to this host, and the cloud security
# group allows 443. The certificate itself is issued over HTTP-01 on port 80.
set -euo pipefail

DOMAIN=${DOMAIN:-}
[ -n "$DOMAIN" ] || { echo "Usage: DOMAIN=example.com bash enable-https.sh"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

UNIT=/etc/systemd/system/thickearth.service
CONF=/etc/nginx/conf.d/thickearth.conf
WEBROOT=/usr/share/nginx/html
OLD_ORIGIN=$(grep -oP '(?<=PUBLIC_ORIGIN=).*' "$UNIT" | head -1)
PUBLIC_IP=${PUBLIC_IP:-$(printf '%s' "$OLD_ORIGIN" | sed -E 's#^https?://##; s#/.*$##')}
CERT=/etc/letsencrypt/live/$DOMAIN

log() { printf '\n==> %s\n' "$1"; }

log "DNS check"
RESOLVED=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | head -1 || true)
echo "$DOMAIN -> ${RESOLVED:-<no answer>} | expected $PUBLIC_IP"
[ "$RESOLVED" = "$PUBLIC_IP" ] || {
  echo "DNS is not pointing here yet. Fix the A record / nameservers first."
  exit 1
}

log "Certificate tooling"
if ! command -v certbot >/dev/null 2>&1; then
  dnf install -y certbot >/dev/null 2>&1 || python3 -m pip install certbot >/dev/null
fi
command -v certbot

log "Open the ACME challenge path"
mkdir -p "$WEBROOT/.well-known/acme-challenge"
cat > "$CONF" <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ { root $WEBROOT; }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
nginx -t && systemctl reload nginx

log "Issue certificate"
certbot certonly --webroot -w "$WEBROOT" \
  -d "$DOMAIN" -d "www.$DOMAIN" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --http-01-port 80 --keep-until-expiring
ls -l "$CERT/fullchain.pem" "$CERT/privkey.pem"

log "Install HTTPS config"
cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate     $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

log "Switch PUBLIC_ORIGIN and secure the cookie"
sed -i "s#^Environment=PUBLIC_ORIGIN=.*#Environment=PUBLIC_ORIGIN=https://$DOMAIN#" "$UNIT"
grep -q '^Environment=COOKIE_SECURE=' "$UNIT" || \
  sed -i '/^Environment=PUBLIC_ORIGIN=/a Environment=COOKIE_SECURE=1' "$UNIT"
systemctl daemon-reload
systemctl restart thickearth
nginx -t && systemctl reload nginx

log "Verify"
sleep 2
curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/config" | head -c 220
printf '\n\nDone: https://%s\n' "$DOMAIN"
echo "Reminder: allow TCP 443 in the cloud security group, and enable renewal:"
echo "  systemctl enable --now certbot-renew.timer"
