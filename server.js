const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── ENV VARIABLES (set in Railway dashboard) ───────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const VSIN_COOKIE  = process.env.VSIN_COOKIE  || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY CACHE ────────────────────────────────────────────────────────
// Prevents hammering APIs on rapid refreshes. Each entry expires after 15 min.
// Think of it like a dictionary: you look up a key, and if the stored answer
// is still fresh, you use it instead of calling the API again.
const cache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes in milliseconds

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// Helper: wraps any async function with caching.
// First call fetches from API; subsequent calls within 15 min return cached data.
async function cachedFetch(key, fetchFn) {
  const cached = getCached(key);
  if (cached !== null) return cached;
  const data = await fetchFn();
  setCache(key, data);
  return data;
}

// ─── STATIC DATA ─────────────────────────────────────────────────────────────

// Parks with retractable roofs or fully enclosed (weather irrelevant)
const DOME_PARKS = [
  'tropicana field', 'minute maid park', 'chase field', 't-mobile park',
  'american family field', 'rogers centre', 'loandepot park', 'oracle park',
  'globe life field', 'petco park'
];

// Park strikeout factors vs league average (>1 = more Ks, <1 = fewer Ks)
// Based on multi-year Statcast park factor data
const PARK_K_FACTORS = {
  'tropicana field': 1.08,
  'oracle park': 1.07,
  'petco park': 1.06,
  'great american ball park': 1.05,
  'citi field': 1.05,
  'guaranteed rate field': 1.04,
  'busch stadium': 1.03,
  'nationals park': 1.02,
  'fenway park': 1.01,
  'dodger stadium': 1.01,
  'wrigley field': 1.00,
  'yankee stadium': 0.99,
  'camden yards': 0.99,
  'progressive field': 0.98,
  'pnc park': 0.98,
  'target field': 0.97,
  'kauffman stadium': 0.97,
  'angel stadium': 0.97,
  'minute maid park': 0.96,
  'globe life field': 0.96,
  'chase field': 0.96,
  'american family field': 0.95,
  'coors field': 0.90  // altitude kills breaking ball movement
};

// MLB team abbreviation -> GPS + park name (for weather lookups)
const TEAM_LOCATIONS = {
  'NYY': { lat: 40.8296, lng: -73.9262, park: 'yankee stadium' },
  'NYM': { lat: 40.7571, lng: -73.8458, park: 'citi field' },
  'BOS': { lat: 42.3467, lng: -71.0972, park: 'fenway park' },
  'TB':  { lat: 27.7682, lng: -82.6534, park: 'tropicana field' },
  'TOR': { lat: 43.6414, lng: -79.3894, park: 'rogers centre' },
  'BAL': { lat: 39.2838, lng: -76.6218, park: 'camden yards' },
  'CLE': { lat: 41.4962, lng: -81.6852, park: 'progressive field' },
  'CWS': { lat: 41.8300, lng: -87.6338, park: 'guaranteed rate field' },
  'DET': { lat: 42.3390, lng: -83.0485, park: 'comerica park' },
  'MIN': { lat: 44.9817, lng: -93.2776, park: 'target field' },
  'KC':  { lat: 39.0517, lng: -94.4803, park: 'kauffman stadium' },
  'HOU': { lat: 29.7573, lng: -95.3555, park: 'minute maid park' },
  'LAA': { lat: 33.8003, lng: -117.8827, park: 'angel stadium' },
  'OAK': { lat: 37.7516, lng: -122.2005, park: 'oakland coliseum' },
  'SEA': { lat: 47.5914, lng: -122.3325, park: 't-mobile park' },
  'TEX': { lat: 32.7512, lng: -97.0832, park: 'globe life field' },
  'ATL': { lat: 33.8908, lng: -84.4678, park: 'truist park' },
  'MIA': { lat: 25.7781, lng: -80.2197, park: 'loandepot park' },
  'PHI': { lat: 39.9061, lng: -75.1665, park: 'citizens bank park' },
  'WSH': { lat: 38.8730, lng: -77.0074, park: 'nationals park' },
  'CHC': { lat: 41.9484, lng: -87.6553, park: 'wrigley field' },
  'CIN': { lat: 39.0975, lng: -84.5080, park: 'great american ball park' },
  'MIL': { lat: 43.0280, lng: -87.9712, park: 'american family field' },
  'PIT': { lat: 40.4469, lng: -80.0057, park: 'pnc park' },
  'STL': { lat: 38.6226, lng: -90.1928, park: 'busch stadium' },
  'ARI': { lat: 33.4455, lng: -112.0667, park: 'chase field' },
  'COL': { lat: 39.7559, lng: -104.9942, park: 'coors field' },
  'LAD': { lat: 34.0739, lng: -118.2400, park: 'dodger stadium' },
  'SD':  { lat: 32.7076, lng: -117.1570, park: 'petco park' },
  'SF':  { lat: 37.7786, lng: -122.3893, park: 'oracle park' }
};

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────

// 1. THE ODDS API — today's MLB games + game totals
async function fetchOddsData() {
  return cachedFetch('odds_games', async () => {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`;
      const res = await fetch(url);
      const games = await res.json();
      if (!Array.isArray(games)) {
        console.log('Odds API returned non-array:', JSON.stringify(games).slice(0, 200));
        return [];
      }
      return games;
    } catch (e) {
      console.error('Odds API error:', e.message);
      return [];
    }
  });
}

// Fetch player props for a specific Odds API event
// market examples: 'pitcher_strikeouts', 'batter_total_bases', 'batter_hits_runs_rbis'
async function fetchGameProps(eventId, market) {
  return cachedFetch(`props_${eventId}_${market}`, async () => {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${market}&oddsFormat=american`;
      const res = await fetch(url);
      const data = await res.json();
      return data;
    } catch (e) {
      console.error(`Props fetch error (${market}):`, e.message);
      return null;
    }
  });
}

// 2. MLB STATS API — today's schedule, lineups, pitcher info
async function fetchMLBSchedule() {
  return cachedFetch('mlb_schedule', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,lineups,team,venue`;
      const res = await fetch(url);
      const data = await res.json();
      return data.dates?.[0]?.games || [];
    } catch (e) {
      console.error('MLB schedule error:', e.message);
      return [];
    }
  });
}

// Fetch pitcher game log (last starts for K/9, ERA, rest days, form)
async function fetchPitcherStats(pitcherId) {
  return cachedFetch(`pitcher_${pitcherId}`, async () => {
    try {
      const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=2026&sportId=1`;
      const res = await fetch(url);
      const data = await res.json();
      return data.stats?.[0]?.splits || [];
    } catch (e) {
      console.error('Pitcher stats error:', e.message);
      return [];
    }
  });
}

// Fetch batter game log (recent form — total bases, H+R+RBI per game)
async function fetchBatterStats(batterId) {
  return cachedFetch(`batter_${batterId}`, async () => {
    try {
      const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=gameLog&group=hitting&season=2026&sportId=1`;
      const res = await fetch(url);
      const data = await res.json();
      return data.stats?.[0]?.splits || [];
    } catch (e) {
      return [];
    }
  });
}

// Fetch player bio (handedness — batSide + pitchHand)
async function fetchPlayerInfo(playerId) {
  return cachedFetch(`info_${playerId}`, async () => {
    try {
      const url = `https://statsapi.mlb.com/api/v1/people/${playerId}`;
      const res = await fetch(url);
      const data = await res.json();
      const person = data.people?.[0];
      return {
        batSide: person?.batSide?.code || 'R',
        pitchHand: person?.pitchHand?.code || 'R'
      };
    } catch (e) {
      return { batSide: 'R', pitchHand: 'R' };
    }
  });
}

// Fetch team-level strikeout stats (opposing team K%)
async function fetchTeamStats() {
  return cachedFetch('team_stats', async () => {
    try {
      const url = `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=2026&sportId=1`;
      const res = await fetch(url);
      const data = await res.json();
      return data.stats?.[0]?.splits || [];
    } catch (e) {
      console.error('Team stats error:', e.message);
      return [];
    }
  });
}

// 3. OPEN-METEO — free weather API, no key needed
async function fetchWeather(lat, lng) {
  return cachedFetch(`weather_${lat}_${lng}`, async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto&forecast_days=1`;
      const res = await fetch(url);
      const data = await res.json();
      // Get conditions around 7pm local (index ~19 in hourly array)
      const idx = 19;
      return {
        tempF: data.hourly?.temperature_2m?.[idx] || 70,
        windSpeed: data.hourly?.windspeed_10m?.[idx] || 0,
        windDir: data.hourly?.winddirection_10m?.[idx] || 0
      };
    } catch (e) {
      console.error('Weather error:', e.message);
      return { tempF: 70, windSpeed: 0, windDir: 0 };
    }
  });
}

// 4. UMPIRE SCORECARDS — free, daily ump assignments + K rate impact
async function fetchUmpireData() {
  return cachedFetch('umpires', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const url = `https://umpscorecards.com/api/umpires/games?date=${today}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) return {};
      const data = await res.json();
      const umpMap = {};
      if (Array.isArray(data)) {
        data.forEach(game => {
          if (game.venue && game.ump_hp) {
            umpMap[game.game_id] = {
              name: game.ump_hp,
              kRate: game.k_rate_boost || 0
            };
          }
        });
      }
      return umpMap;
    } catch (e) {
      console.log('Umpire data unavailable, skipping');
      return {};
    }
  });
}

// 5. BallparkPal strikeout projections (free public API — powers VSIN strikeout page)
async function fetchVSINStrikeouts() {
  return cachedFetch('vsin_k', async () => {
    try {
      const res = await fetch('https://www.ballparkpal.com/StrikeoutPropsGet.php', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const map = {};
      for (const item of data) {
        const name = (item.playerName || '').toLowerCase().trim();
        if (!name) continue;

        const projection = parseFloat(item.Projection) || 0;
        const projLine   = parseFloat(item.BetLine)    || 0;
        const probability = parseFloat(item.Probability) || 0;

        // Convert market odds string (e.g. "+115", "-130") to implied probability
        const oddsStr = (item.Odds || '').trim();
        let marketProb = 0.5;
        if (oddsStr) {
          const odds = parseInt(oddsStr, 10);
          marketProb = odds > 0
            ? 100 / (odds + 100) / 100
            : Math.abs(odds) / (Math.abs(odds) + 100) / 100;
        }

        // Value % = edge our model has over market in probability terms
        const valuePct = probability > 0 ? (probability - marketProb) * 100 : 0;

        map[name] = { projection, projLine, probability, valuePct };
      }
      console.log(`BallparkPal K: loaded ${Object.keys(map).length} pitchers`);
      return map;
    } catch (e) {
      console.log('BallparkPal strikeouts unavailable:', e.message);
      return {};
    }
  });
}

// BallparkPal YRFI — server-rendered HTML, free, no auth required
// Maps team abbreviation (lowercase, BPP format) → { modelProb, nrfiProb }
async function fetchVSINYRFI() {
  return cachedFetch('vsin_yrfi', async () => {
    try {
      const res = await fetch('https://www.ballparkpal.com/First-Inning.php', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const $ = cheerio.load(html);
      const map = {};

      $('tr').each((i, row) => {
        const teamCell = $(row).find('td[data-column="teams"]');
        const yrfiCell = $(row).find('td[data-column="yrfi"]');
        if (!teamCell.length || !yrfiCell.length) return;

        // Team abbrs come from img src, e.g. "Images/chw-logo.svg" → "chw"
        const imgs = teamCell.find('img');
        if (imgs.length < 2) return;
        const awayAbbr = $(imgs[0]).attr('src')?.match(/\/([a-z]+)-logo\.svg/i)?.[1]?.toLowerCase();
        const homeAbbr = $(imgs[1]).attr('src')?.match(/\/([a-z]+)-logo\.svg/i)?.[1]?.toLowerCase();

        const yrfiPct = parseFloat(yrfiCell.text()) || 0;
        if (!awayAbbr || !homeAbbr || !yrfiPct) return;

        const entry = { modelProb: yrfiPct, nrfiProb: 100 - yrfiPct };
        map[awayAbbr] = entry;
        map[homeAbbr] = entry;
      });

      console.log(`BallparkPal YRFI: loaded ${Object.keys(map).length} team entries`);
      return map;
    } catch (e) {
      console.log('BallparkPal YRFI unavailable:', e.message);
      return {};
    }
  });
}

// BallparkPal uses short lowercase abbrs; MLB Stats API uses uppercase (sometimes different).
// This map handles the mismatches; everything else just needs .toLowerCase().
const MLB_TO_BPP = {
  'CWS': 'chw', 'WSH': 'was', 'WAS': 'was', 'ATH': 'oak',
  'NYY': 'nyy', 'NYM': 'nym', 'LAD': 'lad', 'LAA': 'laa',
  'TBR': 'tb',  'TB':  'tb',  'SDP': 'sd',  'SFG': 'sf',
  'KCR': 'kc',  'KC':  'kc'
};

// ─── SCORING ENGINE ────────────────────────────────────────────────────────────
// Each function returns { score: 0-100, reasons: string[] }

function scoreStrikeoutProp(data) {
  let score = 0;
  const reasons = [];

  // 1. VSIN Value % (up to 20 pts) — most important signal
  if (data.vsinValuePct > 0) {
    const pts = Math.min(20, data.vsinValuePct * 2);
    score += pts;
    reasons.push(`VSIN edge +${data.vsinValuePct.toFixed(1)}% value`);
  }

  // 2. Pitcher K/9 rate (up to 20 pts)
  const k9 = data.pitcherK9 || 0;
  if (k9 >= 11)      { score += 20; reasons.push(`Elite K/9 ${k9.toFixed(1)}`); }
  else if (k9 >= 10) { score += 16; reasons.push(`Strong K/9 ${k9.toFixed(1)}`); }
  else if (k9 >= 9)  { score += 12; reasons.push(`Good K/9 ${k9.toFixed(1)}`); }
  else if (k9 >= 8)  { score += 7;  reasons.push(`Avg K/9 ${k9.toFixed(1)}`); }
  else if (k9 >= 7)  { score += 3; }

  // 3. Opposing team K% (up to 15 pts)
  const oppKPct = data.opposingTeamKPct || 0;
  if (oppKPct >= 0.27)      { score += 15; reasons.push(`Opp K% ${(oppKPct*100).toFixed(0)}% (top tier)`); }
  else if (oppKPct >= 0.25) { score += 11; reasons.push(`Opp K% ${(oppKPct*100).toFixed(0)}%`); }
  else if (oppKPct >= 0.23) { score += 7; }
  else if (oppKPct >= 0.21) { score += 3; }

  // 4. Line value — projection meaningfully exceeds posted line (up to 10 pts)
  const projVsLine = (data.vsinProjection || 0) - (data.postedLine || 0);
  if (projVsLine >= 1.5)      { score += 10; reasons.push(`Proj ${data.vsinProjection} vs line ${data.postedLine} (+${projVsLine.toFixed(1)})`); }
  else if (projVsLine >= 1.0) { score += 7; reasons.push(`Proj ${data.vsinProjection} over line by 1.0`); }
  else if (projVsLine >= 0.5) { score += 4; }

  // 5. Umpire strike zone (up to 10 pts)
  if (data.umpKRateBoost >= 0.03)       { score += 10; reasons.push(`Ump ${data.umpName} calls wide zone`); }
  else if (data.umpKRateBoost >= 0.015) { score += 6; }
  else if (data.umpKRateBoost <= -0.02) { score -= 5; reasons.push(`⚠️ Ump tight zone penalty`); }

  // 6. Park K factor (up to 10 pts)
  const kFactor = data.parkKFactor || 1.0;
  if (kFactor >= 1.06)      { score += 10; reasons.push(`K-friendly park (${kFactor.toFixed(2)}x)`); }
  else if (kFactor >= 1.03) { score += 6; }
  else if (kFactor <= 0.93) { score -= 8; reasons.push(`⚠️ K-suppressing park (Coors)`); }
  else if (kFactor <= 0.96) { score -= 4; }

  // 7. Weather — wind-in helps Ks (up to 10 pts)
  if (!data.isDome) {
    if (data.windIn && data.windSpeed >= 15)      { score += 10; reasons.push(`Wind in ${data.windSpeed}mph ↑Ks`); }
    else if (data.windIn && data.windSpeed >= 10) { score += 6; reasons.push(`Wind in ${data.windSpeed}mph`); }
    if (data.tempF <= 55)       { score += 5; reasons.push(`Cold ${data.tempF}°F ↑Ks`); }
    else if (data.tempF >= 85)  { score -= 3; }
  }

  // 8. Pitcher rest (up to 5 pts)
  if (data.restDays >= 6)      { score += 5; reasons.push(`Extra rest ${data.restDays}d`); }
  else if (data.restDays <= 3) { score -= 3; reasons.push(`⚠️ Short rest`); }

  // 9. PENALTY — short leash / opener risk
  if (data.openerRisk) { score -= 10; reasons.push(`⚠️ Opener risk`); }

  // 10. Recent form — last 3 starts hit the over
  if (data.recentOverRate >= 0.67) { score += 5; reasons.push(`Hit K over in ${Math.round(data.recentOverRate*3)}/3 recent starts`); }

  // 11. Game total bonus — low-scoring game = more Ks
  if (data.gameTotal && data.gameTotal <= 7.5) { score += 5; reasons.push(`Low total ${data.gameTotal}`); }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

function scoreNRFIProp(data) {
  let score = 0;
  const reasons = [];

  // 1. Both pitchers' 1st inning ERA proxy (up to 30 pts)
  const avgERA = ((data.homePitcher1stERA || 4.5) + (data.awayPitcher1stERA || 4.5)) / 2;
  if (avgERA <= 1.5)      { score += 30; reasons.push(`Elite pitcher ERA avg ${avgERA.toFixed(2)}`); }
  else if (avgERA <= 2.5) { score += 22; reasons.push(`Strong pitcher ERA avg ${avgERA.toFixed(2)}`); }
  else if (avgERA <= 3.5) { score += 14; }
  else if (avgERA >= 5.0) { score -= 5; reasons.push(`⚠️ Weak pitcher ERAs`); }

  // 2. VSIN model probability (up to 25 pts)
  if (data.vsinNRFIProb >= 65)      { score += 25; reasons.push(`VSIN NRFI model ${data.vsinNRFIProb}%`); }
  else if (data.vsinNRFIProb >= 58) { score += 18; }
  else if (data.vsinNRFIProb >= 52) { score += 10; }

  // 3. Game total (up to 15 pts) — low total = good for NRFI
  const total = data.gameTotal || 8.5;
  if (total <= 7.0)      { score += 15; reasons.push(`Very low total ${total}`); }
  else if (total <= 7.5) { score += 11; reasons.push(`Low total ${total}`); }
  else if (total <= 8.0) { score += 7; }
  else if (total >= 9.5) { score -= 5; reasons.push(`⚠️ High total ${total}`); }

  // 4. Weather (up to 10 pts) — wind-in + cold suppresses runs
  if (!data.isDome) {
    if (data.windIn && data.windSpeed >= 10)      { score += 10; reasons.push(`Wind in ${data.windSpeed}mph ↓ runs`); }
    else if (data.windIn && data.windSpeed >= 8)  { score += 6; }
    if (data.tempF <= 55) { score += 5; reasons.push(`Cold ${data.tempF}°F`); }
    if (data.windOut && data.windSpeed >= 10) { score -= 8; reasons.push(`⚠️ Wind out ${data.windSpeed}mph`); }
  }

  // 5. Neither team top-10 in 1st-inning scoring (up to 20 pts)
  const bothNotExplosive = !data.homeTeamTopFirstInning && !data.awayTeamTopFirstInning;
  if (bothNotExplosive) { score += 20; reasons.push('Neither team top 1st-inn scorers'); }
  else if (data.homeTeamTopFirstInning || data.awayTeamTopFirstInning) {
    score -= 5; reasons.push('⚠️ One team scores early frequently');
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

function scoreTotalBasesProp(data) {
  let score = 0;
  const reasons = [];

  // 1. VSIN Opta projection vs line (up to 30 pts)
  if (data.vsinValuePct > 0) {
    const pts = Math.min(30, data.vsinValuePct * 3);
    score += pts;
    reasons.push(`VSIN Opta edge +${data.vsinValuePct.toFixed(1)}%`);
  }

  // 2. Lineup position — top of order = more at-bats (up to 15 pts)
  if (data.lineupPos <= 2)      { score += 15; reasons.push(`Batting ${data.lineupPos} (premium ABs)`); }
  else if (data.lineupPos <= 4) { score += 10; reasons.push(`Batting ${data.lineupPos}`); }
  else if (data.lineupPos >= 7) { score -= 5; reasons.push(`⚠️ Batting low ${data.lineupPos}`); }

  // 3. Platoon advantage (up to 10 pts)
  // In baseball, lefty batters hit better vs righty pitchers and vice versa
  if (data.platoonAdvantage)    { score += 10; reasons.push(`Platoon adv (${data.hitterHand} vs ${data.pitcherHand})`); }
  else if (data.platoonDisadvantage) { score -= 5; reasons.push(`⚠️ Platoon disadvantage`); }

  // 4. Opposing pitcher ERA/WHIP (up to 15 pts)
  const era = data.oppPitcherERA || 4.5;
  if (era >= 5.5)      { score += 15; reasons.push(`Weak opp pitcher ERA ${era.toFixed(2)}`); }
  else if (era >= 4.5) { score += 9; }
  else if (era <= 2.5) { score -= 8; reasons.push(`⚠️ Elite opp pitcher ERA ${era.toFixed(2)}`); }
  else if (era <= 3.0) { score -= 4; }

  // 5. Hitter recent form (up to 15 pts)
  const avgTB = data.recentAvgTB || 1.5;
  const propLine = data.propLine || 1.5;
  if (avgTB >= propLine + 0.8)      { score += 15; reasons.push(`Hot streak — avg ${avgTB.toFixed(1)}/g`); }
  else if (avgTB >= propLine + 0.4) { score += 10; reasons.push(`Solid form — avg ${avgTB.toFixed(1)}/g`); }
  else if (avgTB >= propLine)       { score += 5; }
  else if (avgTB < propLine - 0.5)  { score -= 5; reasons.push(`⚠️ Cold — avg ${avgTB.toFixed(1)}/g`); }

  // 6. Weather — warm + wind-out helps hitters (up to 10 pts)
  if (!data.isDome) {
    if (data.windOut && data.windSpeed >= 12)      { score += 10; reasons.push(`Wind out ${data.windSpeed}mph ↑ hits`); }
    else if (data.windOut && data.windSpeed >= 8)  { score += 6; }
    if (data.tempF >= 80) { score += 5; reasons.push(`Warm ${data.tempF}°F`); }
    if (data.windIn && data.windSpeed >= 12) { score -= 6; reasons.push(`⚠️ Wind in ${data.windSpeed}mph`); }
    if (data.tempF <= 50) { score -= 5; reasons.push(`⚠️ Cold ${data.tempF}°F`); }
  }

  // 7. Day-after-night-game penalty
  if (data.dayAfterNight) { score -= 5; reasons.push(`⚠️ Day game after night game`); }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

// ─── WIND DIRECTION HELPERS ──────────────────────────────────────────────────
// Wind direction in degrees = direction wind is blowing FROM
// Most parks: wind from S/SW (135-255) is "blowing out" toward outfield
function isWindBlowingOut(windDirDeg) {
  return windDirDeg >= 135 && windDirDeg <= 255;
}

function isWindBlowingIn(windDirDeg) {
  return windDirDeg >= 315 || windDirDeg <= 45;
}

// ─── DATA ENRICHMENT HELPERS ────────────────────────────────────────────────

// Calculate real rest days from pitcher's last game log date
function calculateRestDays(gameLogs) {
  if (!gameLogs || gameLogs.length === 0) return 5; // safe default
  const lastGame = gameLogs[gameLogs.length - 1];
  const lastDate = lastGame.date;
  if (!lastDate) return 5;
  const last = new Date(lastDate);
  const today = new Date();
  return Math.floor((today - last) / (1000 * 60 * 60 * 24));
}

// Compute ERA from a set of game log entries (earned runs / innings * 9)
function computeERA(gameLogs) {
  if (!gameLogs || gameLogs.length === 0) return 4.50;
  const totalER = gameLogs.reduce((sum, g) => sum + parseInt(g.stat?.earnedRuns || 0), 0);
  const totalIP = gameLogs.reduce((sum, g) => sum + parseFloat(g.stat?.inningsPitched || 0), 0);
  return totalIP > 0 ? (totalER / totalIP) * 9 : 4.50;
}

// Compute average total bases per game from batter game log
function computeRecentTB(gameLogs, count) {
  const recent = gameLogs.slice(-count);
  if (recent.length === 0) return 1.5;
  const tbPerGame = recent.map(g => {
    const h  = parseInt(g.stat?.hits || 0);
    const d  = parseInt(g.stat?.doubles || 0);
    const t  = parseInt(g.stat?.triples || 0);
    const hr = parseInt(g.stat?.homeRuns || 0);
    // Total bases = singles*1 + doubles*2 + triples*3 + HR*4
    return (h - d - t - hr) + (d * 2) + (t * 3) + (hr * 4);
  });
  return tbPerGame.reduce((a, b) => a + b, 0) / tbPerGame.length;
}

// Compute average H+R+RBI per game from batter game log
function computeRecentHRBI(gameLogs, count) {
  const recent = gameLogs.slice(-count);
  if (recent.length === 0) return 2.0;
  const hrbiPerGame = recent.map(g => {
    const h   = parseInt(g.stat?.hits || 0);
    const r   = parseInt(g.stat?.runs || 0);
    const rbi = parseInt(g.stat?.rbi || 0);
    return h + r + rbi;
  });
  return hrbiPerGame.reduce((a, b) => a + b, 0) / hrbiPerGame.length;
}

// Extract prop lines from an Odds API response into a name->line lookup map
// Example: { "gerrit cole": 6.5, "carlos rodon": 5.5 }
function extractPropLines(propsData) {
  const lines = {};
  if (!propsData?.bookmakers) return lines;
  // Use the first bookmaker that has data
  for (const bk of propsData.bookmakers) {
    const market = bk.markets?.[0];
    if (market?.outcomes) {
      market.outcomes.forEach(o => {
        if (o.name === 'Over' && o.description) {
          const name = o.description.toLowerCase().trim();
          if (!lines[name]) lines[name] = o.point;
        }
      });
      if (Object.keys(lines).length > 0) break;
    }
  }
  return lines;
}

// ─── MAIN API ENDPOINT ────────────────────────────────────────────────────────
app.get('/api/parlay', async (req, res) => {
  try {
    console.log('Building daily parlay card...');
    const startTime = Date.now();

    // ── PHASE 1: Fetch all global data in parallel ──────────────────────────
    // These 6 calls all go out at the same time (Promise.all), so instead of
    // waiting for each one to finish before starting the next, they all run
    // simultaneously. This is the single biggest speed improvement.
    const [mlbGames, oddsGames, teamStats, vsinKData, vsinYRFI, umpireData] = await Promise.all([
      fetchMLBSchedule(),
      fetchOddsData(),
      fetchTeamStats(),
      fetchVSINStrikeouts(),
      fetchVSINYRFI(),
      fetchUmpireData()
    ]);

    console.log(`Phase 1 done: ${mlbGames.length} games, ${oddsGames.length} odds events`);

    // Build team K% lookup from season stats
    const teamKPctMap = {};
    teamStats.forEach(t => {
      if (t.team?.abbreviation) {
        const total = t.stat?.plateAppearances || 1;
        const ks = t.stat?.strikeOuts || 0;
        teamKPctMap[t.team.abbreviation] = ks / total;
      }
    });

    // Match MLB games to Odds API events by team mascot name
    const oddsGameMap = {}; // mlbGamePk -> oddsGame
    for (const game of mlbGames) {
      const homeName = game.teams?.home?.team?.name?.split(' ').pop() || '';
      const oddsMatch = oddsGames.find(g =>
        g.home_team?.includes(homeName)
      );
      if (oddsMatch) oddsGameMap[game.gamePk] = oddsMatch;
    }

    // ── PHASE 2: Batch-fetch weather for all parks in parallel ──────────────
    // Old code fetched weather one park at a time inside the game loop (slow).
    // New code collects all unique parks, fetches them all at once.
    const weatherPromises = {};
    for (const game of mlbGames) {
      const abbr = game.teams?.home?.team?.abbreviation || '';
      const loc = TEAM_LOCATIONS[abbr];
      if (loc && !weatherPromises[abbr]) {
        weatherPromises[abbr] = fetchWeather(loc.lat, loc.lng);
      }
    }
    const weatherEntries = Object.entries(weatherPromises);
    const weatherData = await Promise.all(weatherEntries.map(([, p]) => p));
    const weatherMap = {};
    weatherEntries.forEach(([abbr], i) => { weatherMap[abbr] = weatherData[i]; });

    // ── PHASE 3: Batch-fetch pitcher stats + handedness in parallel ─────────
    const pitcherIds = new Set();
    for (const game of mlbGames) {
      const hp = game.teams?.home?.probablePitcher;
      const ap = game.teams?.away?.probablePitcher;
      if (hp?.id) pitcherIds.add(hp.id);
      if (ap?.id) pitcherIds.add(ap.id);
    }

    const pitcherIdList = [...pitcherIds];
    const [pitcherStatsArr, pitcherInfoArr] = await Promise.all([
      Promise.all(pitcherIdList.map(id => fetchPitcherStats(id))),
      Promise.all(pitcherIdList.map(id => fetchPlayerInfo(id)))
    ]);

    // Build lookup maps: pitcherId -> stats/info
    const pitcherStatsMap = {};
    const pitcherInfoMap = {};
    pitcherIdList.forEach((id, i) => {
      pitcherStatsMap[id] = pitcherStatsArr[i];
      pitcherInfoMap[id] = pitcherInfoArr[i];
    });

    // ── PHASE 4: Batch-fetch batter stats + handedness for lineup players ───
    const batterIds = new Set();
    for (const game of mlbGames) {
      const homePlayers = game.lineups?.homePlayers || [];
      const awayPlayers = game.lineups?.awayPlayers || [];
      // Only top 4 in lineup (per spec: positions 1-4 get full scoring credit)
      [...homePlayers.slice(0, 4), ...awayPlayers.slice(0, 4)].forEach(p => {
        if (p?.id) batterIds.add(p.id);
      });
    }

    const batterIdList = [...batterIds];
    const [batterStatsArr, batterInfoArr] = await Promise.all([
      Promise.all(batterIdList.map(id => fetchBatterStats(id))),
      Promise.all(batterIdList.map(id => fetchPlayerInfo(id)))
    ]);

    const batterStatsMap = {};
    const batterInfoMap = {};
    batterIdList.forEach((id, i) => {
      batterStatsMap[id] = batterStatsArr[i];
      batterInfoMap[id] = batterInfoArr[i];
    });

    console.log(`Phase 3-4 done: ${pitcherIdList.length} pitchers, ${batterIdList.length} batters`);

    // ── PHASE 5: Fetch prop lines from Odds API per game ────────────────────
    // Gets real posted lines (K overs, TB overs, H+R+RBI overs) from sportsbooks.
    // These calls use your Odds API credits — cached for 15 min to be efficient.
    const propPromises = [];
    for (const game of mlbGames) {
      const oddsMatch = oddsGameMap[game.gamePk];
      if (!oddsMatch) continue;
      propPromises.push(
        fetchGameProps(oddsMatch.id, 'pitcher_strikeouts')
          .then(data => ({ gamePk: game.gamePk, market: 'pitcher_strikeouts', data })),
        fetchGameProps(oddsMatch.id, 'batter_total_bases')
          .then(data => ({ gamePk: game.gamePk, market: 'batter_total_bases', data })),
        fetchGameProps(oddsMatch.id, 'batter_hits_runs_rbis')
          .then(data => ({ gamePk: game.gamePk, market: 'batter_hits_runs_rbis', data }))
      );
    }
    const propResults = await Promise.all(propPromises);

    // Organize: { gamePk: { kLines: {...}, tbLines: {...}, hrbiLines: {...} } }
    const propLinesMap = {};
    for (const result of propResults) {
      if (!propLinesMap[result.gamePk]) propLinesMap[result.gamePk] = {};
      const lines = extractPropLines(result.data);
      if (result.market === 'pitcher_strikeouts') {
        propLinesMap[result.gamePk].kLines = { ...(propLinesMap[result.gamePk].kLines || {}), ...lines };
      } else if (result.market === 'batter_total_bases') {
        propLinesMap[result.gamePk].tbLines = { ...(propLinesMap[result.gamePk].tbLines || {}), ...lines };
      } else if (result.market === 'batter_hits_runs_rbis') {
        propLinesMap[result.gamePk].hrbiLines = { ...(propLinesMap[result.gamePk].hrbiLines || {}), ...lines };
      }
    }

    console.log(`Phase 5 done: prop lines fetched for ${Object.keys(propLinesMap).length} games`);

    // ── PHASE 6: Score all props ────────────────────────────────────────────
    const allProps = [];

    for (const game of mlbGames) {
      const homeTeam = game.teams?.home?.team;
      const awayTeam = game.teams?.away?.team;
      const venue = game.venue?.name?.toLowerCase() || '';
      const gameId = game.gamePk;
      const isDome = DOME_PARKS.some(d => venue.includes(d.split(' ')[0]));
      const homeAbbr = homeTeam?.abbreviation || '';
      const loc = TEAM_LOCATIONS[homeAbbr] || { lat: 40.0, lng: -75.0, park: '' };

      // Pre-fetched weather for this park
      const weather = weatherMap[homeAbbr] || { tempF: 70, windSpeed: 0, windDir: 0 };
      const windOut = !isDome && isWindBlowingOut(weather.windDir);
      const windIn  = !isDome && isWindBlowingIn(weather.windDir);
      const parkKFactor = PARK_K_FACTORS[loc.park] || 1.0;

      // Game total from Odds API
      const oddsMatch = oddsGameMap[gameId];
      const gameTotal = oddsMatch?.bookmakers?.[0]?.markets?.find(m => m.key === 'totals')
        ?.outcomes?.find(o => o.name === 'Over')?.point || 8.5;

      // Prop lines for this game from Odds API
      const gameProps = propLinesMap[gameId] || {};

      // ── PITCHER STRIKEOUT PROPS ─────────────────────────────────────────
      const homePitcher = game.teams?.home?.probablePitcher;
      const awayPitcher = game.teams?.away?.probablePitcher;

      const pitchers = [
        { ...(homePitcher || {}), team: homeTeam, side: 'home', oppTeam: awayTeam },
        { ...(awayPitcher || {}), team: awayTeam, side: 'away', oppTeam: homeTeam }
      ].filter(p => p.id);

      // Compute ERA for each pitcher (reused later for NRFI + opposing pitcher scoring)
      const pitcherERAMap = {};

      for (const pitcher of pitchers) {
        const pitcherName = pitcher.fullName?.toLowerCase() || '';
        const vsinData = vsinKData[pitcherName] || {};
        const gameLogs = pitcherStatsMap[pitcher.id] || [];
        const last5 = gameLogs.slice(-5);

        // K/9 from last 5 starts
        const k9Values = last5.map(g => {
          const ip = parseFloat(g.stat?.inningsPitched || 0);
          const ks = parseInt(g.stat?.strikeOuts || 0);
          return ip > 0 ? (ks / ip) * 9 : 0;
        }).filter(v => v > 0);
        const k9 = k9Values.length > 0 ? k9Values.reduce((a, b) => a + b) / k9Values.length : 0;

        // ERA from last 5 starts (earned runs / innings pitched * 9)
        const pitcherERA = computeERA(last5);
        pitcherERAMap[pitcher.id] = pitcherERA;

        // Real rest days from game log dates (instead of always defaulting to 5)
        const restDays = calculateRestDays(gameLogs);

        // Real posted K line: prefer Odds API > VSIN > K/9-based estimate
        const oddsKLine = gameProps.kLines?.[pitcherName];
        const postedLine = oddsKLine || vsinData.projLine || (k9 > 0 ? Math.floor(k9 * 5.5 / 9) + 0.5 : 5.5);

        // Recent over rate (how often pitcher hit the K over in last 3 starts)
        const last3 = gameLogs.slice(-3);
        const recentOverRate = last3.filter(g =>
          parseInt(g.stat?.strikeOuts || 0) > postedLine
        ).length / Math.max(last3.length, 1);

        // Opener risk: if pitcher averaged under 4.5 IP in recent starts
        const avgIP = last5.reduce((sum, g) => sum + parseFloat(g.stat?.inningsPitched || 5), 0) / Math.max(last5.length, 1);
        const openerRisk = avgIP < 4.5;

        // Umpire data
        const umpInfo = umpireData[gameId] || {};
        const oppAbbr = pitcher.oppTeam?.abbreviation || '';

        const propData = {
          pitcherK9: k9,
          opposingTeamKPct: teamKPctMap[oppAbbr] || 0.22,
          vsinProjection: vsinData.projection || 0,
          vsinValuePct: vsinData.valuePct || 0,
          postedLine,
          umpKRateBoost: umpInfo.kRate || 0,
          umpName: umpInfo.name || 'Unknown',
          parkKFactor,
          isDome,
          windIn,
          windOut,
          windSpeed: weather.windSpeed,
          tempF: weather.tempF,
          restDays,
          openerRisk,
          recentOverRate,
          gameTotal
        };

        const { score, reasons } = scoreStrikeoutProp(propData);

        if (score >= 45) {
          allProps.push({
            type: 'STRIKEOUTS',
            emoji: '⚾',
            player: pitcher.fullName,
            team: pitcher.team?.name,
            opponent: pitcher.oppTeam?.name,
            line: `${postedLine} Ks`,
            direction: 'OVER',
            score,
            reasons,
            gameId: gameId.toString(),
            gameTotal,
            vsinProjection: vsinData.projection ? `${vsinData.projection} Ks` : null
          });
        }
      }

      // ── NRFI PROP ───────────────────────────────────────────────────────
      if (homePitcher?.id && awayPitcher?.id) {
        // Use real computed ERA instead of hardcoded 3.5
        const homePitcherERA = pitcherERAMap[homePitcher.id] || 4.50;
        const awayPitcherERA = pitcherERAMap[awayPitcher.id] || 4.50;

        // BallparkPal YRFI lookup — keyed by lowercase team abbr
        const awayAbbrStr = awayTeam?.abbreviation || '';
        const homeBPP = MLB_TO_BPP[homeAbbr] || homeAbbr.toLowerCase();
        const awayBPP = MLB_TO_BPP[awayAbbrStr] || awayAbbrStr.toLowerCase();
        const vsinYRFIEntry = vsinYRFI[homeBPP] || vsinYRFI[awayBPP];
        const vsinNRFIProb = vsinYRFIEntry ? vsinYRFIEntry.nrfiProb : 0;

        const nrfiData = {
          homePitcher1stERA: homePitcherERA,
          awayPitcher1stERA: awayPitcherERA,
          vsinNRFIProb,
          gameTotal,
          isDome,
          windIn,
          windOut,
          windSpeed: weather.windSpeed,
          tempF: weather.tempF,
          homeTeamTopFirstInning: false,  // enrichable with team splits in future
          awayTeamTopFirstInning: false
        };

        const nrfiResult = scoreNRFIProp(nrfiData);

        if (nrfiResult.score >= 45) {
          allProps.push({
            type: 'NRFI',
            emoji: '🔒',
            player: `${awayTeam?.name} @ ${homeTeam?.name}`,
            team: 'Game Prop',
            opponent: homeTeam?.name,
            line: 'No Run 1st Inning',
            direction: 'NRFI',
            score: nrfiResult.score,
            reasons: nrfiResult.reasons,
            gameId: gameId.toString(),
            gameTotal,
            vsinProjection: vsinYRFIEntry ? `YRFI ${vsinYRFIEntry.modelProb}%` : null
          });
        }
      }

      // ── TOTAL BASES + H+R+RBI PROPS ─────────────────────────────────────
      const homeLineup = game.lineups?.homePlayers || [];
      const awayLineup = game.lineups?.awayPlayers || [];

      // Build batter list: top 4 from each side, with game context attached
      const allBatters = [
        ...homeLineup.slice(0, 4).map((p, i) => ({
          ...p,
          lineupPos: i + 1,
          team: homeTeam,
          oppPitcherId: awayPitcher?.id,
          oppPitcherName: awayPitcher?.fullName
        })),
        ...awayLineup.slice(0, 4).map((p, i) => ({
          ...p,
          lineupPos: i + 1,
          team: awayTeam,
          oppPitcherId: homePitcher?.id,
          oppPitcherName: homePitcher?.fullName
        }))
      ];

      for (const batter of allBatters) {
        if (!batter.id || !batter.fullName) continue;

        const batterName = batter.fullName.toLowerCase().trim();
        const batterLogs = batterStatsMap[batter.id] || [];

        // Real recent total bases average (last 7 games)
        const recentAvgTB = computeRecentTB(batterLogs, 7);

        // Real recent H+R+RBI average (last 7 games)
        const recentAvgHRBI = computeRecentHRBI(batterLogs, 7);

        // Real opposing pitcher ERA (from computed game log data)
        const oppERA = batter.oppPitcherId ? (pitcherERAMap[batter.oppPitcherId] || 4.50) : 4.50;

        // Real platoon data from player info API
        const bInfo = batterInfoMap[batter.id] || { batSide: 'R' };
        const pInfo = batter.oppPitcherId ? (pitcherInfoMap[batter.oppPitcherId] || { pitchHand: 'R' }) : { pitchHand: 'R' };
        const batSide = bInfo.batSide;
        const pitchHand = pInfo.pitchHand;

        // Platoon: L hits better vs R, R hits better vs L. Switch (S) always has advantage.
        const platoonAdv = batSide === 'S' || (batSide === 'L' && pitchHand === 'R') || (batSide === 'R' && pitchHand === 'L');
        const platoonDis = batSide !== 'S' && batSide === pitchHand;

        // ── Total Bases prop ──
        const tbPropLine = gameProps.tbLines?.[batterName] || 1.5;
        const tbData = {
          lineupPos: batter.lineupPos,
          platoonAdvantage: platoonAdv,
          platoonDisadvantage: platoonDis,
          hitterHand: batSide,
          pitcherHand: pitchHand,
          oppPitcherERA: oppERA,
          recentAvgTB: recentAvgTB,
          propLine: tbPropLine,
          vsinValuePct: 0,
          isDome,
          windOut,
          windIn,
          windSpeed: weather.windSpeed,
          tempF: weather.tempF,
          dayAfterNight: false
        };

        const tbResult = scoreTotalBasesProp(tbData);

        if (tbResult.score >= 45) {
          allProps.push({
            type: 'TOTAL BASES',
            emoji: '🏃',
            player: batter.fullName,
            team: batter.team?.name,
            opponent: batter.oppPitcherName || 'Unknown',
            line: `${tbPropLine} TB`,
            direction: 'OVER',
            score: tbResult.score,
            reasons: tbResult.reasons,
            gameId: gameId.toString(),
            gameTotal,
            vsinProjection: null
          });
        }

        // ── H+R+RBI prop (same scoring model, different stat) ──
        const hrbiPropLine = gameProps.hrbiLines?.[batterName] || 2.5;
        const hrbiData = {
          lineupPos: batter.lineupPos,
          platoonAdvantage: platoonAdv,
          platoonDisadvantage: platoonDis,
          hitterHand: batSide,
          pitcherHand: pitchHand,
          oppPitcherERA: oppERA,
          recentAvgTB: recentAvgHRBI,  // H+R+RBI avg instead of TB avg
          propLine: hrbiPropLine,
          vsinValuePct: 0,
          isDome,
          windOut,
          windIn,
          windSpeed: weather.windSpeed,
          tempF: weather.tempF,
          dayAfterNight: false
        };

        const hrbiResult = scoreTotalBasesProp(hrbiData);

        if (hrbiResult.score >= 45) {
          allProps.push({
            type: 'H+R+RBI',
            emoji: '🔥',
            player: batter.fullName,
            team: batter.team?.name,
            opponent: batter.oppPitcherName || 'Unknown',
            line: `${hrbiPropLine} H+R+RBI`,
            direction: 'OVER',
            score: hrbiResult.score,
            reasons: hrbiResult.reasons,
            gameId: gameId.toString(),
            gameTotal,
            vsinProjection: null
          });
        }
      }
    }

    // ── PHASE 7: Sort and build the parlay ──────────────────────────────────
    // Sort all scored props from highest to lowest
    allProps.sort((a, b) => b.score - a.score);

    // Pick top 4 legs — no two from the same game (avoids correlated legs)
    const usedGames = new Set();
    const parlayLegs = [];

    // First pass: only take legs scoring 55+ (strong plays)
    for (const prop of allProps) {
      if (parlayLegs.length >= 4) break;
      if (prop.score < 55) continue;
      if (!usedGames.has(prop.gameId)) {
        parlayLegs.push(prop);
        usedGames.add(prop.gameId);
      }
    }

    // Second pass: if we couldn't fill 4 legs, relax to 45+ (thin day)
    if (parlayLegs.length < 4) {
      for (const prop of allProps) {
        if (parlayLegs.length >= 4) break;
        if (prop.score < 45) continue;
        if (!usedGames.has(prop.gameId)) {
          parlayLegs.push(prop);
          usedGames.add(prop.gameId);
        }
      }
    }

    // Data source status for the UI pills
    const dataStatus = {
      oddsApi: oddsGames.length > 0,
      mlbStats: mlbGames.length > 0,
      vsinStrikeouts: Object.keys(vsinKData).length > 0,
      vsinYRFI: Object.keys(vsinYRFI).length > 0,
      umpires: Object.keys(umpireData).length > 0
    };

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Parlay card built in ${elapsed}s — ${allProps.length} total props scored, ${parlayLegs.length} legs selected`);

    res.json({
      date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      parlayLegs,
      fullBoard: allProps.slice(0, 25), // Top 25 for full board view
      dataStatus,
      gamesProcessed: mlbGames.length
    });

  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SEASON TRACKING — save/load results ────────────────────────────────────
const RESULTS_FILE = path.join(__dirname, 'results.json');

app.get('/api/results', (req, res) => {
  try {
    const data = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE)) : { results: [] };
    res.json(data);
  } catch (e) {
    res.json({ results: [] });
  }
});

app.post('/api/results', (req, res) => {
  try {
    const existing = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE)) : { results: [] };
    existing.results.push({ ...req.body, savedAt: new Date().toISOString() });
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MLB Parlay Builder running on port ${PORT}`);
  console.log(`Odds API: ${ODDS_API_KEY ? '✓ configured' : '✗ missing'}`);
  console.log(`VSIN Cookie: ${VSIN_COOKIE ? '✓ configured' : '✗ missing'}`);
});
