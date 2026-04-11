# MLB Parlay Builder

Daily 4-leg MLB prop parlay tracker using a composite scoring model across:
- Pitcher Strikeout props
- NRFI (No Run First Inning) props  
- Total Bases / H+R+RBI props

Best 4 plays from any market each day, ranked by composite score. No same-game legs.

## Scoring Factors

| Signal | Markets | Source |
|--------|---------|--------|
| VSIN Ballpark Pal K projection vs line | Strikeouts | VSIN Pro (cookie) |
| Pitcher K/9 & SwStr% (last 5 starts) | Strikeouts | MLB Stats API |
| Opposing team K% | Strikeouts | MLB Stats API |
| Umpire strike zone rating | Strikeouts | Umpire Scorecards |
| Park K factor | Strikeouts | Static table |
| Pitcher rest days | Strikeouts | MLB Stats API |
| Both pitchers' 1st-inning ERA | NRFI | MLB Stats API |
| VSIN YRFI model probability | NRFI | VSIN Pro (cookie) |
| Game total | NRFI + K | Odds API |
| Wind direction/speed (10+ mph matters) | All outdoor | Open-Meteo |
| Temperature (<55°F / >80°F) | All outdoor | Open-Meteo |
| Dome/roof flag (nullifies weather) | All | Static table |
| Hitter lineup position (top 5 only) | Total Bases | MLB Stats API |
| Platoon advantage | Total Bases | MLB Stats API |
| Opposing pitcher ERA/WHIP | Total Bases | MLB Stats API |
| Hitter recent form (last 7 games) | Total Bases | MLB Stats API |
| Day-after-night-game penalty | All | MLB Stats API |
| Opener/short leash penalty | Strikeouts | MLB Stats API |

## Railway Deployment

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/mlb-parlay-builder.git
git push -u origin main
```

### Step 2: Create Railway Project
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select `mlb-parlay-builder`
3. Railway auto-detects Node.js and deploys

### Step 3: Set Environment Variables in Railway Dashboard
Go to your service → Variables tab → Add:

| Variable | Value |
|----------|-------|
| `ODDS_API_KEY` | Your The Odds API key |
| `VSIN_COOKIE` | Your VSIN Pro cookie string |

### Getting Your VSIN Cookie
1. Log into vsin.com in Chrome
2. Open DevTools (F12) → Network tab
3. Refresh the page
4. Click any request to vsin.com
5. Under Request Headers, find `Cookie:`
6. Copy the entire cookie string value
7. Paste into Railway as `VSIN_COOKIE`

**Note:** Cookie expires periodically. When VSIN data shows as unavailable (yellow pill),
refresh your cookie in Railway Variables. The app degrades gracefully — all other 
data sources continue working.

## Local Development
```bash
npm install
ODDS_API_KEY=your_key VSIN_COOKIE=your_cookie node server.js
```
Then open http://localhost:3000
