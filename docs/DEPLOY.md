# Production deployment — nft-live-feed

Single-VPS topology, Cloudflare → nginx → { Next.js :3001, Express :3000 }.
Backend and frontend both bind to `127.0.0.1`; only nginx is reachable from
the public internet.

This doc is the long form. For day-2 operations jump to
[Commands](#commands).

---

## Topology

```
internet
  │  HTTPS, DNS
Cloudflare (proxied A record → VPS IPv4)
  │  HTTPS, origin cert
nginx :443 on VPS
  ├─ /                  → 127.0.0.1:3001   (Next.js)
  ├─ /api/*             → 127.0.0.1:3000   (Express backend)
  ├─ /api/events/stream → 127.0.0.1:3000   (SSE, no buffering)
  └─ /webhooks/*        → 127.0.0.1:3000   (optional)

Not exposed:
  - :3000 backend
  - :3001 frontend
  - :5432 postgres
```

---

## 1. VPS one-time setup

Reference distro: Ubuntu 22.04 LTS. Swap package-manager commands for your
distro if different.

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install build-essential git curl ca-certificates ufw \
                    nginx certbot python3-certbot-nginx

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs

# Postgres 16 (local; swap for managed DB later if desired)
sudo apt -y install postgresql postgresql-contrib
sudo systemctl enable --now postgresql

sudo -u postgres psql <<'SQL'
CREATE USER nftfeed WITH PASSWORD 'REPLACE_ME_STRONG';
CREATE DATABASE nft_live_feed OWNER nftfeed;
SQL

# PM2
sudo npm i -g pm2

# Service user — never run node as root
sudo adduser --disabled-password --gecos "" nftfeed
```

## 2. Clone + env

```bash
sudo -iu nftfeed
git clone git@github.com:YOUR_ORG/nft-live-feed.git ~/nft-live-feed
cd ~/nft-live-feed
```

### Backend `~/nft-live-feed/.env`

Copy `.env.production.example` and fill in real values.

```ini
NODE_ENV=production
PORT=3000

UI_AUTH_PASSWORD=<operator passphrase>
UI_AUTH_SECRET=<openssl rand -hex 32>
UI_ALLOWED_WALLETS=<base58 wallet>[,<base58 wallet> …]
UI_ALLOWED_ORIGINS=https://your-domain.com

HELIUS_API_KEY=<helius key>
DATABASE_URL=postgres://nftfeed:REPLACE_ME_STRONG@127.0.0.1:5432/nft_live_feed

# Optional — only if you want the buy endpoint live
# ME_API_KEY=<magiceden key>
```

`chmod 600 .env`. The backend's `validateEnv()` refuses to start in
production when any of the six required vars are missing, when
`UI_AUTH_SECRET` is shorter than 16 chars, or when it would silently
fall back to `UI_AUTH_PASSWORD` for token signing.

### Frontend `~/nft-live-feed/frontend/.env.production`

```ini
NEXT_PUBLIC_API_URL=https://your-domain.com
```

Same origin as the frontend ⇒ no CORS surface. For a split `api.` host,
set `NEXT_PUBLIC_API_URL=https://api.your-domain.com` and add that host
to both the nginx `server_name` and `UI_ALLOWED_ORIGINS`.

## 3. Install, migrate, build

```bash
cd ~/nft-live-feed
npm ci
npm run migrate

cd frontend
npm ci
npm run build
cd ..
```

## 4. PM2

`ecosystem.config.cjs` lives at the repo root. Bootstrap it once:

```bash
mkdir -p ~/logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u nftfeed --hp /home/nftfeed
# run the printed sudo command so PM2 survives reboots
```

## 5. nginx — `/etc/nginx/sites-available/nft-live-feed`

```nginx
server {
  listen 80;
  listen [::]:80;
  server_name your-domain.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name your-domain.com;

  ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;
  ssl_ciphers         HIGH:!aNULL:!MD5;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer-when-downgrade" always;

  # Cloudflare real-client-IP so backend rate-limiter keys on the user.
  real_ip_header CF-Connecting-IP;
  set_real_ip_from 173.245.48.0/20;
  set_real_ip_from 103.21.244.0/22;
  set_real_ip_from 103.22.200.0/22;
  set_real_ip_from 103.31.4.0/22;
  set_real_ip_from 141.101.64.0/18;
  set_real_ip_from 108.162.192.0/18;
  set_real_ip_from 190.93.240.0/20;
  set_real_ip_from 188.114.96.0/20;
  set_real_ip_from 197.234.240.0/22;
  set_real_ip_from 198.41.128.0/17;
  set_real_ip_from 162.158.0.0/15;
  set_real_ip_from 104.16.0.0/13;
  set_real_ip_from 104.24.0.0/14;
  set_real_ip_from 172.64.0.0/13;
  set_real_ip_from 131.0.72.0/22;
  set_real_ip_from 2400:cb00::/32;
  set_real_ip_from 2606:4700::/32;
  set_real_ip_from 2803:f800::/32;
  set_real_ip_from 2405:b500::/32;
  set_real_ip_from 2405:8100::/32;
  set_real_ip_from 2a06:98c0::/29;
  set_real_ip_from 2c0f:f248::/32;

  client_max_body_size 10m;
  proxy_http_version 1.1;
  proxy_set_header Host              $host;
  proxy_set_header X-Real-IP         $remote_addr;
  proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  # SSE: no buffering, long read timeout
  location ~ ^/(api/events/stream|events/stream)$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
    chunked_transfer_encoding off;
    proxy_set_header Connection '';
  }

  location /api/      { proxy_pass http://127.0.0.1:3000; }
  location /webhooks/ { proxy_pass http://127.0.0.1:3000; }
  location /          { proxy_pass http://127.0.0.1:3001; }
}
```

Enable and obtain a cert:

```bash
sudo ln -sf /etc/nginx/sites-available/nft-live-feed /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com --redirect --agree-tos \
             -m you@your-domain.com
```

If you use a Cloudflare Origin Certificate instead of Let's Encrypt,
install the cert + key under `/etc/ssl/` and point `ssl_certificate*` at
those paths.

## 6. Cloudflare

1. DNS → **A record** `your-domain.com` → VPS IPv4, **Proxy = Proxied** (orange cloud).
2. SSL/TLS → **Full (strict)**.
3. Edge Certificates → **Always Use HTTPS**, **Automatic HTTPS Rewrites**, **Min TLS 1.2**.
4. Network → **WebSockets = On** (future-proof; SSE works either way).
5. Rules → disable **Rocket Loader** for this domain (it breaks hydration).
6. Security → add a rate-limit rule on `/api/auth/login`
   (e.g. 10 requests / 5 min / IP → block 10 min) as a second line of
   defense in front of the backend's own 5-per-5-min limiter.
7. WAF → leave managed rules on.

## 7. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# 3000/3001 intentionally NOT opened — nginx reaches them on localhost.
sudo ufw enable
sudo ufw status verbose
```

Postgres stays bound to `127.0.0.1` (Debian/Ubuntu default). Verify with
`ss -tlnp | grep 5432`. Don't open 5432 in ufw.

---

## Commands

Day-2 reference.

```bash
# Status and logs
pm2 status
pm2 logs                              # tails both apps
pm2 logs nft-backend  --lines 200
pm2 logs nft-frontend --lines 200

# Restart / reload
pm2 restart nft-backend               # honours kill_timeout=10000
pm2 restart nft-frontend
pm2 reload ecosystem.config.cjs --update-env   # picks up new .env values

# Stop / start
pm2 stop nft-backend
pm2 start nft-backend

# nginx
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log

# Cert renewal (certbot timer runs automatically)
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run

# DB
psql -U nftfeed -h 127.0.0.1 -d nft_live_feed
```

### Update deploy

From the repo root as the `nftfeed` user:

```bash
./deploy.sh
```

That script does: `git reset --hard origin/main` → `npm ci` →
`npm run migrate` → frontend `npm ci && npm run build` →
`pm2 reload ecosystem.config.cjs --update-env` → `pm2 save` →
`pm2 status`. Idempotent; re-running after a partial failure is safe.

### Rollback

```bash
cd ~/nft-live-feed
git log --oneline -20                 # pick a known-good SHA
git reset --hard <sha>
npm ci
(cd frontend && npm ci && npm run build)
pm2 reload ecosystem.config.cjs --update-env
```

Schema migrations are additive — if a migration is the reason for
rollback, restore from `pg_dump` first.

---

## Pre-launch checklist

- [ ] `.env` on the server has all six required vars. `chmod 600 .env`.
- [ ] `UI_AUTH_SECRET` ≠ `UI_AUTH_PASSWORD`. Generated with `openssl rand -hex 32`.
- [ ] `UI_ALLOWED_WALLETS` lists the operator wallet(s) only.
- [ ] `UI_ALLOWED_ORIGINS=https://your-domain.com` (exact, no trailing slash).
- [ ] `frontend/.env.production` has `NEXT_PUBLIC_API_URL=https://your-domain.com`.
- [ ] `npm run build` in `frontend/` completes; `.next/` present.
- [ ] `npm run migrate` applied on the server's DB.
- [ ] `ufw status` shows only 22/80/443 inbound.
- [ ] `ss -tlnp` shows :3000 and :3001 bound to `127.0.0.1`.
- [ ] `curl https://your-domain.com/health` → `{"status":"ok"}`.
- [ ] `curl https://your-domain.com/api/runtime/mode` → `{"mode":"off"}`.
- [ ] Browser login at `/access` works; mode select → dashboard flows.
- [ ] `pm2 startup` enabled so the stack survives reboot.
- [ ] DB backup scheduled (nightly `pg_dump` to offsite, or managed DB).
- [ ] Log rotation — `pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 14`.
