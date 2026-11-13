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
