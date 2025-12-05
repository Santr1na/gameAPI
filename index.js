require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const NodeCache = require('node-cache');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3002;

// Firebase
// Firebase — РАБОЧИЙ ВАРИАНТ ДЛЯ ПРОДАКШЕНА
// Firebase — РАБОЧИЙ ВАРИАНТ ДЛЯ ЛЮБОГО ХОСТИНГА
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('ОШИБКА: Нет FIREBASE_SERVICE_ACCOUNT в .env');
    process.exit(1);
  }

  try {
    const serviceAccount = require("/root/gameAPI/serviceAccountKey.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin подключён через service account (VPS)');
  } catch (err) {
    console.error('Не удалось инициализировать Firebase:', err.message);
    process.exit(1);
  }
}

const db = admin.firestore();

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// Cache
const cache = new NodeCache({ stdTTL: 86400 });
const historyCache = new NodeCache({ stdTTL: 604800 });
const historyKey = 'recent_games';

// IGDB
const clientId = process.env.IGDB_CLIENT_ID || '6suowimw8bemqf3u9gurh7qnpx74sd';
const clientSecret = process.env.IGDB_CLIENT_SECRET || 'powongmt2u3r0jb136tfqhq0r8t5gb';
let accessToken = '';
const igdbUrl = 'https://api.igdb.com/v4/games';
const steamUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
let igdbHeaders = { 'Client-ID': clientId, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/plain' };
let steamApps = null;

// Steam apps
async function getSteamApps() {
  if (steamApps) return steamApps;
  try {
    const res = await axios.get(steamUrl, { timeout: 10000 });
    steamApps = res.data.applist.apps;
    return steamApps;
  } catch (err) {
    console.error('Steam fetch error:', err.message);
    return [];
  }
}

// Token refresh
async function refreshAccessToken() {
  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' },
      timeout: 10000,
    });
    accessToken = res.data.access_token;
    igdbHeaders = { 'Client-ID': clientId, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/plain' };
    console.log('Token refreshed');
    return accessToken;
  } catch (err) {
    console.error('Token refresh ERROR:', err.response?.data || err.message);
    throw err;
  }
}

// Auth
async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    console.error('Auth ERROR:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Firestore helpers
async function loadStatusCounts() { try { const doc = await db.collection('counters').doc('statuses').get(); return doc.exists ? doc.data() : {}; } catch (e) { console.error('Load status ERROR:', e); return {}; } }
async function saveStatusCounts(c) { try { await db.collection('counters').doc('statuses').set(c); } catch (e) { console.error('Save status ERROR:', e); } }

// Utils
function weightedShuffle(arr, hist) {
  return arr.map(g => ({ g, w: hist.includes(g.id) ? 0.01 : 1 * (Math.random() + 1) }))
    .sort((a, b) => b.w - a.w).map(i => i.g);
}
function updateHistory(ids) {
  let h = historyCache.get(historyKey) || [];
  h = [...new Set([...ids, ...h])].slice(0, 200);
  historyCache.set(historyKey, h);
}
async function getSteamCover(name, plats) {
  if (!plats.includes('Steam')) return null;
  const key = `steam_${name.toLowerCase()}`;
  if (cache.get(key)) return cache.get(key);
  const apps = await getSteamApps();
  const app = apps.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (app) {
    const url = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
    cache.set(key, url, 86400);
    return url;
  }
  return null;
}
async function getGameCover(name, plats, igdb) {
  const steam = await getSteamCover(name, plats);
  return steam || (igdb !== 'N/A' ? igdb.replace('t_thumb', 't_cover_big') : igdb);
}

// Processors
async function processSearchGame(g) {
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  return { id: g.id, name: g.name, cover_image: await getGameCover(g.name, plats, cover), rating: Math.round(g.aggregated_rating || g.rating || 0) || 'N/A', description: g.summary || 'N/A' , platforms: plats , release_year: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).getFullYear() : 'N/A' , main_genre: g.genres?.[0]?.name || 'N/A'};
}
async function processPopularGame(g) {
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  return { id: g.id, name: g.name, cover_image: await getGameCover(g.name, plats, cover), critic_rating: Math.round(g.aggregated_rating || 0) || 'N/A', release_year: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).getFullYear() : 'N/A', main_genre: g.genres?.[0]?.name || 'N/A', platforms: plats };
}
async function processGame(g) {
  // === Читаем счётчик favorite ===
  let favoriteCount = 0;
  try {
    const favSnap = await db.collection('counters').doc('favorites').get();
    if (favSnap.exists) {
      const data = favSnap.data();
      favoriteCount = data[g.id] || 0;
    }
  } catch (err) {
    console.error('Error loading favorite count for game', g.id, err);
    favoriteCount = 0;
  }

  // === Читаем статусы (playing, ill_play и т.д.) ===
  const statusCounts = { playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 };
  try {
    const statusSnap = await db.collection('counters').doc('statuses').get();
    if (statusSnap.exists) {
      const gameStats = statusSnap.data()[g.id] || {};
      Object.keys(statusCounts).forEach(key => {
        statusCounts[key] = gameStats[key] || 0;
      });
    }
  } catch (err) {
    console.error('Error loading status counts for game', g.id, err);
  }

  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  const genres = g.genres ? g.genres.map(gg => gg.name) : [];

  const PEGI_RATING_MAP = { 7: '3', 8: '7', 9: '12', 10: '16', 11: '18' };
  const PEGI_ORG_ID = 2;
  const FALLBACK = { 7346: '12', 1942: '18', 19560: '18', 11156: '16', 250: '18', 287: '18', 242408: '18' };

  let ageRatings = ['Pending'];
  if (g.age_ratings && g.age_ratings.length > 0) {
    const pegi = g.age_ratings.find(r => r.organization === PEGI_ORG_ID && r.rating_category);
    if (pegi) {
      ageRatings = [`PEGI: ${PEGI_RATING_MAP[pegi.rating_category] || '??'}`];
    }
  } else if (FALLBACK[g.id]) {
    ageRatings = [`PEGI: ${FALLBACK[g.id]}`];
  } else {
    const name = g.name.toLowerCase();
    if (name.includes("counter-strike") || name.includes("call of duty") || name.includes("battlefield")) {
      ageRatings = ["PEGI: 18"];
    } else if (g.genres?.some(genre => ["Shooter", "Horror"].includes(genre.name))) {
      ageRatings = ["PEGI: 18"];
    } else if (name.includes("minecraft") || name.includes("lego")) {
      ageRatings = ["PEGI: 7"];
    } else if (name.includes("fifa") || name.includes("nba")) {
      ageRatings = ["PEGI: 3"];
    } else {
      ageRatings = ["PEGI: 12"];
    }
  }

  const similar = g.similar_games?.length
    ? await Promise.all(
        g.similar_games.slice(0, 3).map(async s => {
          const sc = s.cover ? `https:${s.cover.url}` : 'N/A';
          const sp = s.platforms ? s.platforms.map(p => p.name) : [];
          return {
            id: s.id,
            name: s.name,
            cover_image: await getGameCover(s.name, sp, sc),
            critic_rating: Math.round(s.aggregated_rating || 0) || 'N/A',
            release_year: s.release_dates?.[0]?.date
              ? new Date(s.release_dates[0].date * 1000).getFullYear()
              : 'N/A',
            main_genre: s.genres?.[0]?.name || 'N/A',
            platforms: sp
          };
        })
      )
    : [];

  return {
    id: g.id,
    name: g.name,
    genres,
    platforms: plats,
    release_date: g.release_dates?.[0]?.date
      ? new Date(g.release_dates[0].date * 1000).toISOString().split('T')[0]
      : 'N/A',
    rating: Math.round(g.aggregated_rating || g.rating || 0) || 'N/A',
    rating_type: g.aggregated_rating ? 'Critics' : 'Users',
    cover_image: await getGameCover(g.name, plats, cover),
    age_ratings: (() => {
      const HARD_FALLBACK = {
        242408: '18', 7346: '12', 1942: '18', 19560: '18', 11156: '16', 250: '18', 287: '18'
      };
      if (HARD_FALLBACK[g.id]) return [`PEGI: ${HARD_FALLBACK[g.id]}`];
      if (g.age_ratings && g.age_ratings.length > 0) {
        const pegi = g.age_ratings.find(r => r.organization === 2);
        if (pegi) {
          if (pegi.rating_category && [7,8,9,10,11].includes(pegi.rating_category)) {
            const map = { 7: '3', 8: '7', 9: '12', 10: '16', 11: '18' };
            return [`PEGI: ${map[pegi.rating_category]}`];
          }
          if (pegi.rating && [7,8,9,10,11].includes(pegi.rating)) {
            const map = { 7: '3', 8: '7', 9: '12', 10: '16', 11: '18' };
            return [`PEGI: ${map[pegi.rating]}`];
          }
        }
      }
      const name = g.name.toLowerCase();
      if (name.includes('counter-strike') || name.includes('cs2') || name.includes('cs:go')) return ['PEGI: 18'];
      if (g.genres?.some(g => ['Shooter', 'Horror', 'Action'].includes(g.name))) return ['PEGI: 18'];
      if (name.includes('minecraft') || name.includes('lego')) return ['PEGI: 7'];
      if (name.includes('fifa') || name.includes('nba') || name.includes('pes')) return ['PEGI: 3'];
      return ['PEGI: 12'];
    })(),
    summary: g.summary || 'N/A',
    developers: g.involved_companies && g.involved_companies.length > 0
      ? g.involved_companies
          .filter(c => c.developer || c.publisher)
          .map(c => c.company?.name)
          .filter(Boolean)
          .slice(0, 3)
      : [],
    similar_games: similar,
    favorite: favoriteCount,
    playing: statusCounts.playing,
    ill_play: statusCounts.ill_play,
    passed: statusCounts.passed,
    postponed: statusCounts.postponed,
    abandoned: statusCounts.abandoned
  };
}

// Routes
app.get('/health', (req, res) => res.json({ status: 'OK' }));

app.get('/popular', async (req, res) => {
  console.log('/popular requested');
  const limit = parseInt(req.query.limit) || 10;
  const body = `fields id,name,cover.url,aggregated_rating,rating,release_dates.date,genres.name,platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; sort aggregated_rating desc; limit ${limit};`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    const games = await Promise.all(r.data.map(processPopularGame));
    res.json(games);
  } catch (err) {
    console.error('/popular ERROR:', err.message, err.response?.status, err.response?.data);
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error' });
  }
});

app.get('/search', async (req, res) => {
  console.log('/search requested');
  const q = req.query.query;
  const limit = parseInt(req.query.limit) || 10;
  if (!q) return res.status(400).json({ error: 'Query required' });
  const body = `fields id,name,cover.url,aggregated_rating,rating,summary,platforms.name,release_dates.date,genres.name; search "${q}"; limit ${limit};`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    const games = await Promise.all(r.data.map(processSearchGame));
    res.json(games);
  } catch (err) {
    console.error('/search ERROR:', err.message, err.response?.status, err.response?.data);
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error' });
  }
});

app.get('/games', async (req, res) => {
  console.log('/games requested');
  const limit = parseInt(req.query.limit) || 5;
  const page = parseInt(req.query.page) || 1;
  const offset = (page - 1) * 50;
  const hist = historyCache.get(historyKey) || [];
  const excl = hist.length ? `where id != (${hist.join(',')});` : '';
  const body = `fields id,name,cover.url,aggregated_rating,release_dates.date,genres.name,platforms.name; ${excl} limit 50; offset ${offset};`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    if (!r.data.length) { historyCache.set(historyKey, []); return res.status(404).json({ error: 'No games' }); }
    const shuffled = weightedShuffle(r.data, hist);
    const selected = shuffled.slice(0, limit);
    updateHistory(selected.map(g => g.id));
    const games = await Promise.all(selected.map(processPopularGame));
    res.json(games);
  } catch (err) {
    console.error('/games ERROR:', err.message, err.response?.status, err.response?.data);
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error' });
  }
});
// 1. Фикс IGDB-запроса — УБРАТЬ ВСЕ ПЕРЕНОСЫ!
app.get('/games/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid ID' });

  const body = `fields id,name,genres.name,platforms.name,release_dates.date,aggregated_rating,rating,cover.url,age_ratings.*,summary,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,videos.video_id,similar_games.id,similar_games.name,similar_games.cover.url,similar_games.aggregated_rating,similar_games.release_dates.date,similar_games.genres.name,similar_games.platforms.name;where id = ${id}; limit 1;`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    if (!r.data.length) return res.status(404).json({ error: 'Game not found' });
    const game = await processGame(r.data[0]);
    res.json(game);
  } catch (err) {
    if (err.response?.status === 401) await refreshAccessToken();
    console.error('/games/:id ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: 'IGDB error' });
  }
});
app.patch('/games/:id', authenticate, async (req, res) => {
  const gameId = req.params.id;
  const { favoriteChange } = req.body;

  if (!gameId || !/^\d+$/.test(gameId) || Math.abs(favoriteChange) !== 1) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const docRef = db.collection('counters').doc('favorites');

    // Атомарно меняем счётчик
    await docRef.set({
      [gameId]: admin.firestore.FieldValue.increment(favoriteChange)
    }, { merge: true });

    // Читаем новое значение
    const snap = await docRef.get();
    const data = snap.data() || {};
    const count = Math.max(data[gameId] || 0, 0);

    res.json({ favorite: count });
  } catch (err) {
    console.error('PATCH favorite error:', err);
    res.status(500).json({ error: 'Failed to update favorite' });
  }
});

const validStatuses = ['playing', 'ill_play', 'passed', 'postponed', 'abandoned'];
app.post('/games/:id/status/:status', authenticate, async (req, res) => {
  const status = req.params.status.toLowerCase();
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const counts = await loadStatusCounts();
    counts[req.params.id] = counts[req.params.id] || {};
    counts[req.params.id][status] = (counts[req.params.id][status] || 0) + 1;
    await saveStatusCounts(counts);
    res.json({ [status]: counts[req.params.id][status] });
  } catch (err) {
    console.error('/status POST ERROR:', err.message);
    res.status(500).json({ error: 'Firestore error' });
  }
});

app.delete('/games/:id/status/:status', authenticate, async (req, res) => {
  const status = req.params.status.toLowerCase();
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const counts = await loadStatusCounts();
    counts[req.params.id] = counts[req.params.id] || {};
    counts[req.params.id][status] = Math.max((counts[req.params.id][status] || 0) - 1, 0);
    await saveStatusCounts(counts);
    res.json({ [status]: counts[req.params.id][status] });
  } catch (err) {
    console.error('/status DELETE ERROR:', err.message);
    res.status(500).json({ error: 'Firestore error' });
  }
});

// Start
const server = app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  try {
    await refreshAccessToken();
    await getSteamApps();
  } catch (e) {
    console.error('Startup ERROR:', e);
  }
});

module.exports = app;
