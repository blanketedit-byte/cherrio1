# cherri-proxy

Server-side web proxy. Strips `X-Frame-Options`, `Content-Security-Policy`, and
other frame-blocking headers. Rewrites all URLs (links, scripts, styles, images,
fetch, XHR, history) to route through the proxy so navigation stays inside cherri.

## Requirements
- Node.js 18+

## Install & run locally

```bash
npm install
npm start
# → http://localhost:3000
```

Dev mode (auto-restart on file change):
```bash
npm run dev
```

## Deploy to Railway (free tier)

1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select the repo — Railway auto-detects Node and runs `npm start`
4. Done. Railway gives you a public URL like `https://cherri-proxy.up.railway.app`

## Deploy to Render (free tier)

1. Push to GitHub
2. https://render.com → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Free tier spins down after inactivity — first load is slow (~30s cold start)

## Deploy to a VPS (DigitalOcean, Hetzner, Vultr)

```bash
git clone <your-repo> cherri
cd cherri
npm install
# Run with PM2 so it stays up
npm install -g pm2
pm2 start server.js --name cherri
pm2 save
pm2 startup
```

Then point nginx at port 3000:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Add SSL with: `certbot --nginx -d yourdomain.com`

## Env vars

| Var    | Default | Description         |
|--------|---------|---------------------|
| `PORT` | `3000`  | HTTP listen port    |

## Routes

| Route               | Description                                              |
|---------------------|----------------------------------------------------------|
| `GET /`             | Serves `public/index.html` (the cherri UI)              |
| `GET /proxy?url=X`  | Proxies X, rewrites HTML URLs, strips frame-kill headers |
| `GET /raw?url=X`    | Passthrough for assets (JS, CSS, images, fonts)         |

## Limits

Sites that use heavy client-side routing (YouTube SPA, Discord React app) will
partially work — the initial HTML loads, but subsequent API calls may be
blocked by the site's own auth or by CORS on their API endpoints.
For maximum compatibility, consider adding a browser-automation layer
(Playwright headless) for sites that fight back hardest.
