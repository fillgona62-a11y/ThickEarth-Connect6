# Deploying ThickEarth on a Linux host

A 4 vCPU / 4 GB VM is far more than this needs: the process is one Node HTTP
server with a SQLite file, no build step and no dependencies. The only resource
that ever gets tight is bandwidth, because every page is served from the VM.

Requires **Node 22.5+** — that is where `node:sqlite` landed.

```bash
# 1. Node 22 from NodeSource (the distro package is usually too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
node -v   # must be >= 22.5

# 2. Code and a service account that owns only its data directory
sudo useradd --system --home /opt/thickearth --shell /usr/sbin/nologin thickearth
sudo git clone https://github.com/fillgona62-a11y/ThickEarth-Connect6.git /opt/thickearth
sudo mkdir -p /var/lib/thickearth
sudo chown -R thickearth:thickearth /opt/thickearth /var/lib/thickearth

# 3. Service, after editing PUBLIC_ORIGIN and the paths to match your host
sudo cp /opt/thickearth/deploy/thickearth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thickearth
curl -s http://127.0.0.1:8080/api/config

# 4. TLS, then the reverse proxy
sudo certbot --nginx -d thickearth.example.com
sudo cp /opt/thickearth/deploy/nginx.conf /etc/nginx/conf.d/thickearth.conf
sudo sed -i 's/thickearth\.example\.com/YOUR.DOMAIN/g' /etc/nginx/conf.d/thickearth.conf
sudo nginx -t && sudo systemctl reload nginx
```

Open 80 and 443 in the cloud security group. Port 8080 stays closed: nginx
reaches it over loopback.

## Things that bite

- `PUBLIC_ORIGIN` must match the URL people type, scheme included. It backs the
  CSRF origin check; a mismatch rejects every POST.
- `COOKIE_SECURE=1` only once HTTPS works. Set it on plain HTTP and login loops.
- The data directory holds two files that belong together: `thickearth.db` and
  `.ai-secret`. The secret decrypts the stored provider API key, so copying the
  database alone leaves the AI settings unreadable. Back up the directory.
- `APP_MODE=web` turns on registration and login. The first player to register
  is an ordinary account — there is no admin role to claim.
- Restart after replacing code: `sudo systemctl restart thickearth`. The SQLite
  file lives outside the checkout, so `git pull` is safe.
- A 3 Mbps uplink is roughly 380 KB/s: fine for this UI, and AI traffic happens
  server-side, so it does not consume the player's bandwidth.

## Variant: OpenCloudOS 9, no domain, HTTP only

Use `thickearth-http.service` and `nginx-http.conf` instead of the two files
above. This is the case for a fresh VM whose security group exposes port 80 but
has no certificate or registered domain.

**Shortcut:** `install-orcaterm.sh` performs this whole section in one pass.
Paste it into the cloud console's web terminal (OrcaTerm) and run as root; it
is idempotent, auto-detects the public IP, and finishes with a self check.
If the host cannot reach GitHub, upload `thickearth-deploy.tar.gz` (a checkout
without `.git`) as `/root/thickearth-deploy.tar.gz` first — the script unpacks
it instead of cloning.

```bash
# Node 22 from NodeSource RPM (OpenCloudOS 9 uses dnf, not apt)
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs nginx
node -v                                  # must be >= 22.5

useradd --system --home /opt/thickearth --shell /sbin/nologin thickearth
git clone https://github.com/fillgona62-a11y/ThickEarth-Connect6.git /opt/thickearth
mkdir -p /var/lib/thickearth
chown -R thickearth:thickearth /opt/thickearth /var/lib/thickearth

# Substitute the public address, then install both units
sed -i 's/YOUR_SERVER_IP/203.0.113.10/g' \
  /opt/thickearth/deploy/thickearth-http.service
cp /opt/thickearth/deploy/thickearth-http.service /etc/systemd/system/thickearth.service
cp /opt/thickearth/deploy/nginx-http.conf /etc/nginx/conf.d/thickearth.conf

# RHEL-family hosts need both of these; Ubuntu does not
firewall-cmd --permanent --add-service=http && firewall-cmd --reload
setsebool -P httpd_can_network_connect 1   # lets nginx reach 127.0.0.1:8080

systemctl daemon-reload
systemctl enable --now thickearth nginx
nginx -t
curl -s http://127.0.0.1/api/config
```

`PUBLIC_ORIGIN` must be exactly `http://<that IP>` — no trailing slash, no
`localhost`, no port 8080. The CSRF check compares it against the browser's
origin, so a mismatch rejects every POST including login.

**AI settings do not come with the code.** `ai_settings` is keyed by `user_id`,
and a fresh web deployment has new account ids, so copying the desktop database
will not make the provider appear. Register an account, open Settings, and enter
the base URL, model and API key again. Do not copy `.ai-secret` or the database
unless you also remap the `ai_settings.user_id` row — that would move a live
credential onto a public host for no benefit.
