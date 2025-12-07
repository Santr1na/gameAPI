// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const cron = require('node-cron');
const admin = require('firebase-admin');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3002;
// -------- Firebase init (supports env JSON or local file) --------
if (!admin.apps.length) {
  try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT.trim()) {
      // FIREBASE_SERVICE_ACCOUNT should be a JSON string
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✓ Firebase Admin подключён через FIREBASE_SERVICE_ACCOUNT (env)');
      console.log('  Service Account:', serviceAccount.client_email);
      console.log('  Project ID:', serviceAccount.project_id);
    } else {
      // fallback to local file (useful for dev / VPS with file present)
      const localPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');
      console.log('Loading Firebase credentials from:', localPath);
      serviceAccount = require(localPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✓ Firebase Admin подключён через serviceAccountKey.json (file)');
      console.log('  Service Account:', serviceAccount.client_email);
      console.log('  Project ID:', serviceAccount.project_id);
    }
  } catch (err) {
    console.error('✗ Не удалось инициализировать Firebase:', err.message);
    if (err.code === 'MODULE_NOT_FOUND') {
      console.error('  Файл serviceAccountKey.json не найден. Проверьте путь к файлу.');
    } else if (err.message.includes('JSON')) {
      console.error('  Ошибка парсинга JSON. Проверьте формат FIREBASE_SERVICE_ACCOUNT.');
    } else {
      console.error('  Детали ошибки:', err);
    }
    process.exit(1);
  }
}
// Firestore не используется - счетчики хранятся в памяти
// const db = admin.firestore(); // Убрано - не нужен для счетчиков

// Test Firebase Auth connection on startup (только для проверки токенов пользователей)
// Firestore проверяется при первом использовании, не блокирует запуск
async function testFirebaseConnection() {
  try {
    console.log('Testing Firebase Auth connection...');
    
    // Verify the app is initialized
    if (!admin.apps.length) {
      console.error('✗ Firebase Admin не инициализирован!');
      return false;
    }
    
    // Test Auth (это все, что нужно для проверки токенов пользователей)
    console.log('✓ Firebase Auth: доступен (проверка токенов пользователей работает)');
    console.log('  Счетчики избранного хранятся в памяти (сбрасываются при перезапуске сервера)');
    
    return true;
  } catch (err) {
    console.error('✗ Firebase Auth connection test FAILED');
    console.error('  Error message:', err.message);
    console.error('  Error code:', err.code);
    return false;
  }
}

// -------- Middleware --------
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json()); // parse application/json
// -------- Cache & history --------
const cache = new NodeCache({ stdTTL: 86400 }); // 24 hours
const historyCache = new NodeCache({ stdTTL: 604800 }); // 7 days
const historyKey = 'recent_games';
// -------- IGDB / Steam config --------
const clientId = process.env.IGDB_CLIENT_ID || '6suowimw8bemqf3u9gurh7qnpx74sd';
const clientSecret = process.env.IGDB_CLIENT_SECRET || process.env.IGDB_CLIENT_SECRET || 'powongmt2u3r0jb136tfqhq0r8t5gb';
let accessToken = process.env.IGDB_ACCESS_TOKEN || '';
const igdbUrl = 'https://api.igdb.com/v4/games';
const steamUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
let igdbHeaders = { 'Client-ID': clientId, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/plain' };
let steamApps = null;
// -------- Steam apps fetch --------
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
// -------- Access token refresh --------
async function refreshAccessToken() {
  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' },
      timeout: 10000,
    });
    accessToken = res.data.access_token;
    igdbHeaders = { 'Client-ID': clientId, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/plain' };
    console.log('IGDB access token refreshed (first 8 chars):', accessToken ? accessToken.slice(0, 8) + '...' : '(empty)');
    return accessToken;
  } catch (err) {
    console.error('Token refresh ERROR:', err.response?.data || err.message);
    throw err;
  }
}
// Schedule daily token refresh at 00:00 server timezone (safe)
cron.schedule('0 0 * * *', async () => {
  console.log('Scheduled access token refresh...');
  try {
    await refreshAccessToken();
  } catch (e) {
    console.error('Scheduled token refresh failed:', e.message);
  }
});
// Optional keep-alive ping to PUBLIC_URL every 10 minutes (to keep free hosts awake)
function scheduleKeepAlive(publicUrl) {
  if (!publicUrl) {
    console.warn('No PUBLIC_URL provided, skip keep-alive ping.');
    return;
  }
  cron.schedule('*/10 * * * *', async () => {
    try {
      const r = await axios.get(`${publicUrl}/health`, { timeout: 5000 });
      if (r.status === 200) {
        console.log(`Keep-alive ping successful to ${publicUrl} at ${new Date().toISOString()}`);
      } else {
        console.warn('Keep-alive ping returned status', r.status);
      }
    } catch (e) {
      console.error('Keep-alive ping failed:', e.message);
    }
  }, { scheduled: true });
}
// -------- Auth middleware --------
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
// -------- Счетчики избранного в памяти --------
// Счетчики хранятся в памяти: favoriteCounts[gameId] = количество пользователей
// При перезапуске сервера счетчики сбрасываются в 0
const favoriteCounts = {}; // { gameId: count }

function getFavoriteCount(gameId) {
  const gameIdStr = String(gameId);
  return favoriteCounts[gameIdStr] || favoriteCounts[gameId] || 0;
}

function updateFavoriteCount(gameId, change) {
  const gameIdStr = String(gameId);
  const currentCount = favoriteCounts[gameIdStr] || favoriteCounts[gameId] || 0;
  const newCount = Math.max(currentCount + change, 0); // Не меньше 0
  favoriteCounts[gameIdStr] = newCount;
  favoriteCounts[gameId] = newCount; // Сохраняем оба ключа для совместимости
  return newCount;
}
// -------- Utils (covers, history, shuffle) --------
function weightedShuffle(arr, hist) {
  return arr.map(g => ({ g, w: hist.includes(g.id) ? 0.01 : (Math.random() + 1) }))
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
  const cached = cache.get(key);
  if (cached) return cached;
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
// -------- Processors (transform IGDB responses to our API shape) --------
async function processSearchGame(g) {
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  return {
    id: g.id,
    name: g.name,
    cover_image: await getGameCover(g.name, plats, cover),
    rating: Math.round(g.aggregated_rating || g.rating || 0) || 'N/A',
    description: g.summary || 'N/A',
    platforms: plats,
    release_year: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).getFullYear() : 'N/A',
    main_genre: g.genres?.[0]?.name || 'N/A'
  };
}
async function processPopularGame(g) {
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  return {
    id: g.id,
    name: g.name,
    cover_image: await getGameCover(g.name, plats, cover),
    critic_rating: Math.round(g.aggregated_rating || 0) || 'N/A',
    release_year: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).getFullYear() : 'N/A',
    main_genre: g.genres?.[0]?.name || 'N/A',
    platforms: plats
  };
}
async function processGame(g) {
  // Получаем счетчик избранного из памяти
  const favoriteCount = getFavoriteCount(g.id);
  
  const statusCounts = { playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 };
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  const genres = g.genres ? g.genres.map(gg => gg.name) : [];
  // similar games
  const similar = g.similar_games?.length
    ? await Promise.all(g.similar_games.slice(0, 3).map(async s => {
      const sc = s.cover ? `https:${s.cover.url}` : 'N/A';
      const sp = s.platforms ? s.platforms.map(p => p.name) : [];
      return {
        id: s.id,
        name: s.name,
        cover_image: await getGameCover(s.name, sp, sc),
        critic_rating: Math.round(s.aggregated_rating || 0) || 'N/A',
        release_year: s.release_dates?.[0]?.date ? new Date(s.release_dates[0].date * 1000).getFullYear() : 'N/A',
        main_genre: s.genres?.[0]?.name || 'N/A',
        platforms: sp
      };
    })) : [];
  // age ratings handling (kept simple)
  const ageRatings = (() => {
    const HARD_FALLBACK = { 242408: '18', 7346: '12', 1942: '18', 19560: '18', 11156: '16', 250: '18', 287: '18' };
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
    const n = (g.name || '').toLowerCase();
    if (n.includes('counter-strike') || n.includes('cs2') || n.includes('cs:go')) return ['PEGI: 18'];
    if (g.genres?.some(gg => ['Shooter', 'Horror', 'Action'].includes(gg.name))) return ['PEGI: 18'];
    if (n.includes('minecraft') || n.includes('lego')) return ['PEGI: 7'];
    if (n.includes('fifa') || n.includes('nba') || n.includes('pes')) return ['PEGI: 3'];
    return ['PEGI: 12'];
  })();
  return {
    id: g.id,
    name: g.name,
    genres,
    platforms: plats,
    release_date: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).toISOString().split('T')[0] : 'N/A',
    rating: Math.round(g.aggregated_rating || g.rating || 0) || 'N/A',
    rating_type: g.aggregated_rating ? 'Critics' : 'Users',
    cover_image: await getGameCover(g.name, plats, cover),
    age_ratings: ageRatings,
    summary: g.summary || 'N/A',
    developers: g.involved_companies && g.involved_companies.length > 0
      ? g.involved_companies.filter(c => c.developer || c.publisher).map(c => c.company?.name).filter(Boolean).slice(0,3)
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
// -------- Routes --------
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
    if (err.response?.status === 401) {
      try { await refreshAccessToken(); } catch(e){/* ignore */ }
    }
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
    if (err.response?.status === 401) {
      try { await refreshAccessToken(); } catch(e){/* ignore */ }
    }
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
    if (err.response?.status === 401) {
      try { await refreshAccessToken(); } catch(e){/* ignore */ }
    }
    res.status(500).json({ error: 'IGDB error' });
  }
});
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
    console.error('/games/:id ERROR:', err.response?.data || err.message);
    if (err.response?.status === 401) {
      try { await refreshAccessToken(); } catch(e){/* ignore */ }
    }
    res.status(500).json({ error: 'IGDB error' });
  }
});
// ---------- Favorite endpoints (как в коммите 80f5e36) ----------
// GET /games/:id/favorite - получить счетчик избранного
app.get('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const count = getFavoriteCount(gameId);
    res.json({ favorite: count });
  } catch (error) {
    console.error('Error /games/:id/favorite (GET):', error.message);
    res.status(500).json({ error: 'Failed to get favorite count' });
  }
});

// POST /games/:id/favorite - увеличить счетчик избранного (+1)
app.post('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const newCount = updateFavoriteCount(gameId, 1);
    console.log(`[POST /games/${gameId}/favorite] Favorite count: ${newCount}`);
    res.json({ favorite: newCount });
  } catch (error) {
    console.error('Error /games/:id/favorite (POST):', error.message);
    res.status(500).json({ error: 'Failed to increment favorite count: ' + error.message });
  }
});

// DELETE /games/:id/favorite - уменьшить счетчик избранного (-1)
app.delete('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const newCount = updateFavoriteCount(gameId, -1);
    console.log(`[DELETE /games/${gameId}/favorite] Favorite count: ${newCount}`);
    res.json({ favorite: newCount });
  } catch (error) {
    console.error('Error /games/:id/favorite (DELETE):', error.message);
    res.status(500).json({ error: 'Failed to decrement favorite count: ' + error.message });
  }
});
// ---------- Status endpoints ----------
const validStatuses = ['playing', 'ill_play', 'passed', 'postponed', 'abandoned'];
app.post('/games/:id/status/:status', authenticate, async (req, res) => {
  const status = req.params.status.toLowerCase();
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // Статус уже сохранен в Firebase клиентом, просто возвращаем успех
  res.json({ [status]: 0 });
});
app.delete('/games/:id/status/:status', authenticate, async (req, res) => {
  const status = req.params.status.toLowerCase();
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // Статус уже удален из Firebase клиентом, просто возвращаем успех
  res.json({ [status]: 0 });
});
app.delete('/games/:id/status', authenticate, async (req, res) => {
  // Все статусы уже удалены из Firebase клиентом, просто возвращаем успех
  res.json({ playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 });
});
// -------- Start server --------
const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
  const publicUrl = process.env.PUBLIC_URL || '';
  if (publicUrl) console.log('Using PUBLIC_URL for keep-alive:', publicUrl);
  try {
    // Test Firebase Auth (только для проверки токенов пользователей)
    const authOk = await testFirebaseConnection();
    if (!authOk) {
      console.log('⚠ Firebase Auth недоступен - аутентификация не будет работать');
    } else {
      console.log('✓ Firebase Auth работает - проверка токенов пользователей доступна');
      console.log('  Счетчики избранного будут работать если Firestore доступен');
      console.log('  Избранное всегда работает через Firebase для каждого пользователя');
    }
    await refreshAccessToken().catch(e => { console.warn('Initial token refresh failed:', e.message); });
    await getSteamApps().catch(e => { console.warn('Initial steam apps fetch failed:', e.message); });
    scheduleKeepAlive(publicUrl);
  } catch (e) {
    console.error('Initial setup failed:', e.message);
  }
});
process.on('SIGTERM', () => {
  server.close(() => {
    console.log(`Server terminated at ${new Date().toISOString()}`);
  });
});
module.exports = app;
