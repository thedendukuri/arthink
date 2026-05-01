# ārthink. — Setup Guide

## Step 1 — Install Node.js (one-time, ~3 minutes)
Go to **https://nodejs.org** → click the green **LTS** button → run the installer → click Next through everything.

To confirm it worked, open Terminal (Mac: Cmd+Space → type "Terminal") and type:
```
node -v
```
You should see something like `v22.x.x`. That means Node is ready.

---

## Step 2 — Install the project's dependencies (one-time, ~1 minute)
In Terminal, navigate to this folder and run `npm install`:

**On Mac:**
```
cd ~/Documents/Claude/Projects/markets\ investing
npm install
```
This downloads Express and the other packages listed in `package.json` into a `node_modules` folder. You only ever do this once (or again if you add new packages).

---

## Step 3 — Run the site locally
```
npm start
```
You'll see:
```
  ╔═══════════════════════════════════╗
  ║   ārthink. is running             ║
  ║   → http://localhost:3000         ║
  ╚═══════════════════════════════════╝
```
Open **http://localhost:3000** in your browser. Live data from Yahoo Finance is now flowing.

To stop the server: press **Ctrl+C** in Terminal.

---

## Step 4 — Put it on the internet (Railway, ~15 minutes)

### 4a — Push your code to GitHub
1. Go to **github.com** → click the **+** → New repository
2. Name it `arthink` → make it **Private** → click Create
3. Follow the "push an existing repository" commands GitHub shows you
   (they look like `git remote add origin ...` and `git push`)

### 4b — Deploy on Railway
1. Go to **railway.app** → Sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `arthink` repo
4. Railway auto-detects Node.js and runs `node server.js` — that's it
5. Click **Generate Domain** to get your live URL (e.g. `arthink-production.railway.app`)

Every time you change the HTML or server and push to GitHub, Railway redeploys automatically in ~60 seconds.

---

## Step 5 — Add Supabase (for user accounts & watchlists, when ready)
1. Go to **supabase.com** → New project
2. In Project Settings → API, copy your **Project URL** and **anon/public key**
3. Copy `.env.example` to `.env` and paste those values in
4. That's the database connected — building watchlists and auth is the next step

---

## Daily use
```
npm start          # start the server
Ctrl+C             # stop it
```
The site runs at http://localhost:3000 while the server is running.
