const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const cron = require('node-cron');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3002;

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
const clientSecret = process.env.IGDB_CLIENT_SECRET || '1257quvt9ary0s7bicrwcsx117lxgn';
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
    console.error('Steam fetch error:', err.message, err.stack, err.response?.data);
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
    console.error('Token refresh ERROR:', err.message, err.stack, err.response?.data);
    throw err;
  }
}

// Auth
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = await admin.auth().verifyIdToken(header.split('Bearer ')[1]);
    next();
  } catch (err) {
    console.error('Auth ERROR:', err.message, err.stack);
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// Firestore helpers
async function loadFavoriteCounts() { try { const doc = await db.collection('counters').doc('favorites').get(); return doc.exists ? doc.data() : {}; } catch (e) { console.error('Load fav ERROR:', e); return {}; } }
async function saveFavoriteCounts(c) { try { await db.collection('counters').doc('favorites').set(c); } catch (e) { console.error('Save fav ERROR:', e); } }
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
  return { id: g.id, name: g.name, cover_image: await getGameCover(g.name, plats, cover), rating: Math.round(g.aggregated_rating || g.rating || 0) || 'N/A', description: g.summary || 'N/A' };
}
async function processPopularGame(g) {
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  return { id: g.id, name: g.name, cover_image: await getGameCover(g.name, plats, cover), critic_rating: Math.round(g.aggregated_rating || 0) || 'N/A', release_year: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).getFullYear() : 'N/A', main_genre: g.genres?.[0]?.name || 'N/A', platforms: plats };
}
async function processGame(g) {
  const favs = await loadFavoriteCounts();
  const stats = await loadStatusCounts();
  const st = stats[g.id] || {};
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  const genres = g.genres ? g.genres.map(gg => gg.name) : [];
  const similar = g.similar_games?.length ? await Promise.all(g.similar_games.slice(0, 3).map(async s => {
    const sc = s.cover ? `https:${s.cover.url}` : 'N/A';
    const sp = s.platforms ? s.platforms.map(p => p.name) : [];
    return { id: s.id, name: s.name, cover_image: await getGameCover(s.name, sp, sc), critic_rating: Math.round(s.aggregated_rating || 0) || 'N/A', release_year: s.release_dates?.[0]?.date ? new Date(s.release_dates[0].date * 1000).getFullYear() : 'N/A', main_genre: s.genres?.[0]?.name || 'N/A', platforms: sp };
  })) : [];
  return {
    id: g.id, name: g.name, genres, platforms: plats,
    release_date: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).toISOString().split('T')[0] : 'N/A',
    rating: Math.round(g.aggregated_rating || g.rating || 0) || 'N/A',
    rating_type: g.aggregated_rating ? 'Critics' : 'Users',
    cover_image: await getGameCover(g.name, plats, cover),
    age_ratings: g.age_ratings ? g.age_ratings.map(r => ({1:'ESRB: EC',2:'ESRB: E',3:'ESRB: E10+',4:'ESRB: T',5:'ESRB: M',6:'ESRB: AO',7:'PEGI: 3',8:'PEGI: 7',9:'PEGI: 12',10:'PEGI: 16',11:'PEGI: 18'}[r.rating] || 'N/A')) : ['N/A'],
    summary: g.summary || 'N/A',
    developers: g.involved_companies ? g.involved_companies.map(c => c.company.name) : ['N/A'],
    videos: g.videos ? g.videos.map(v => `https://www.youtube.com/watch?v=${v.video_id}`).slice(0,3) : ['N/A'],
    similar_games: similar,
    favorite: favs[g.id] || 0,
    playing: st.playing || 0, ill_play: st.ill_play || 0, passed: st.passed || 0, postponed: st.postponed || 0, abandoned: st.abandoned || 0
  };
}

// Routes
app.get('/health', (req, res) => res.json({ status: 'OK' }));

app.get('/popular', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const body = `fields id,name,cover.url,aggregated_rating,rating,release_dates.date,genres.name,platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; sort aggregated_rating desc; limit ${limit};`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    const games = await Promise.all(r.data.map(processPopularGame));
    res.json(games);
  } catch (err) {
    console.error('/popular ERROR:', err.message, err.stack, JSON.stringify(err.response?.data));
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error', details: err.response?.data });
  }
});

app.get('/search', async (req, res) => {
  const q = req.query.query;
  const limit = parseInt(req.query.limit) || 10;
  if (!q) return res.status(400).json({ error: 'Query required' });
  const body = `fields id,name,cover.url,aggregated_rating,rating,summary,platforms.name; search "${q}"; limit ${limit};`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    const games = await Promise.all(r.data.map(processSearchGame));
    res.json(games);
  } catch (err) {
    console.error('/search ERROR:', err.message, err.stack, JSON.stringify(err.response?.data));
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error', details: err.response?.data });
  }
});

app.get('/games', async (req, res) => {
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
    console.error('/games ERROR:', err.message, err.stack, JSON.stringify(err.response?.data));
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error', details: err.response?.data });
  }
});

app.get('/games/:id', async (req, res) => {
  const body = `fields id,name,genres.name,platforms.name,release_dates.date,aggregated_rating,rating,cover.url,age_ratings.rating,summary,involved_companies.company.name,videos.video_id,similar_games.id,similar_games.name,similar_games.cover.url,similar_games.aggregated_rating,similar_games.release_dates.date,similar_games.genres.name,similar_games.platforms.name; where id = ${req.params.id}; limit 1;`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    if (!r.data.length) return res.status(404).json({ error: 'Game not found' });
    const game = await processGame(r.data[0]);
    res.json(game);
  } catch (err) {
    console.error('/games/:id ERROR:', err.message, err.stack, JSON.stringify(err.response?.data));
    if (err.response?.status === 401) await refreshAccessToken();
    res.status(500).json({ error: 'IGDB error', details: err.response?.data });
  }
});

// Favorite routes (с authenticate)
app.get('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const counts = await loadFavoriteCounts();
    res.json({ favorite: counts[req.params.id] || 0 });
  } catch (err) {
    console.error('/favorite GET ERROR:', err.message, err.stack);
    res.status(500).json({ error: 'Firestore error' });
  }
});

app.post('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const counts = await loadFavoriteCounts();
    counts[req.params.id] = (counts[req.params.id] || 0) + 1;
    await saveFavoriteCounts(counts);
    res.json({ favorite: counts[req.params.id] });
  } catch (err) {
    console.error('/favorite POST ERROR:', err.message, err.stack);
    res.status(500).json({ error: 'Firestore error' });
  }
});

app.delete('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const counts = await loadFavoriteCounts();
    counts[req.params.id] = Math.max((counts[req.params.id] || 0) - 1, 0);
    await saveFavoriteCounts(counts);
    res.json({ favorite: counts[req.params.id] });
  } catch (err) {
    console.error('/favorite DELETE ERROR:', err.message, err.stack);
    res.status(500).json({ error: 'Firestore error' });
  }
});

// Status routes
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
    console.error('/status POST ERROR:', err.message, err.stack);
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
    console.error('/status DELETE ERROR:', err.message, err.stack);
    res.status(500).json({ error: 'Firestore error' });
  }
});

// Start
app.listen(PORT, async () => {
  console.log(`Server on port ${PORT}`);
  try {
    await refreshAccessToken();
    await getSteamApps();
  } catch (e) {
    console.error('Startup ERROR:', e.message, e.stack);
  }
});

module.exports = app;
