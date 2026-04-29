# NSE Options Scanner

Real-time NSE F&O scanner that surfaces top 5 gainers and losers, then drills into each stock's options chain (ATM/ITM/OTM) with live OHLC highlights from Upstox.

**Features:**
- Top 5 gainers & top 5 losers from 40 NSE F&O stocks
- ATM/ITM/OTM options chain per stock with real OHLC
- Highlights option strikes where `open = day's low` (green) or `open = day's high` (red)
- Password-protected (private app)
- Server-side proxy for Upstox API (your token never touches a third party)

---

## Local development

### 1. Install
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.local.example .env.local
```

Open `.env.local` and set a strong password:
```
APP_PASSWORD=your-strong-password-here
```

### 3. Run
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to `/login`. Enter the password from `.env.local`, then paste your Upstox JWT in the token panel.

---

## Deploy to Vercel

### Option A: Via the Vercel CLI (fastest)

```bash
npm install -g vercel
vercel
```

Follow the prompts. When asked about environment variables, add:
- `APP_PASSWORD` = your chosen password

### Option B: Via the Vercel dashboard (GitHub-based)

1. Push this folder to a GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin git@github.com:YOUR_USERNAME/nse-options-scanner.git
   git push -u origin main
   ```

2. Go to [vercel.com/new](https://vercel.com/new) and import the repo.

3. In **Environment Variables**, add:
   - `APP_PASSWORD` = your chosen password

4. Click **Deploy**. You'll get a URL like `https://nse-options-scanner.vercel.app`.

5. Visit it → enter your password → paste your Upstox token → scan!

---

## Architecture

```
Browser (you)
    ↓ password cookie + Upstox JWT in memory
Vercel Edge / Serverless Functions
    ├── /api/auth       → validates password, sets HttpOnly session cookie
    ├── /api/upstox     → forwards requests to api.upstox.com server-side
    └── middleware.js   → blocks all unauthorized requests
    ↓ HTTPS (Authorization header)
api.upstox.com
```

The Upstox token is held in your browser's React state (in-memory). When it makes a request, it's sent to `/api/upstox` on your own server, which then forwards to Upstox. Upstox never sees a third-party origin and the token never leaves Vercel's network.

---

## Security notes

- The password protects access to the app itself (anyone with the URL still sees the login page).
- Vercel sets `secure` cookies in production — the session cookie is HTTP-only and not readable by JavaScript.
- The Upstox token lives only in browser memory. Refreshing the page loses it (you re-paste).
- For an extra layer, set up Vercel's [Deployment Protection](https://vercel.com/docs/security/deployment-protection) on top of the app's password gate.

---

## Tech stack

- **Next.js 14** (App Router) — React framework with server functions
- **Vercel** — deployment platform
- No database, no external dependencies beyond Upstox API
