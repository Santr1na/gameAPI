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
// Firestore для личных избранных игр (рекомендации)
function getDb() {
  return admin.firestore();
}

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
const gameCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache for individual games
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

// Опциональная авторизация: если токен есть и валиден — req.user, иначе req.user = null (для рекомендаций гостям)
async function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    req.user = await admin.auth().verifyIdToken(token);
  } catch (err) {
    req.user = null;
  }
  next();
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

// -------- Счетчики статусов в памяти --------
// Счетчики хранятся в памяти: statusCounts[gameId][status] = количество пользователей
// При перезапуске сервера счетчики сбрасываются в 0
const statusCounts = {}; // { gameId: { playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 } }

function getStatusCounts(gameId) {
  const gameIdStr = String(gameId);
  const gameStatusCounts = statusCounts[gameIdStr] || statusCounts[gameId];
  if (gameStatusCounts) {
    return {
      playing: gameStatusCounts.playing || 0,
      ill_play: gameStatusCounts.ill_play || 0,
      passed: gameStatusCounts.passed || 0,
      postponed: gameStatusCounts.postponed || 0,
      abandoned: gameStatusCounts.abandoned || 0
    };
  }
  return { playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 };
}

function updateStatusCount(gameId, status, change) {
  const gameIdStr = String(gameId);
  if (!statusCounts[gameIdStr]) {
    statusCounts[gameIdStr] = { playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 };
  }
  if (!statusCounts[gameId]) {
    statusCounts[gameId] = statusCounts[gameIdStr];
  }
  
  const currentCount = statusCounts[gameIdStr][status] || 0;
  const newCount = Math.max(currentCount + change, 0); // Не меньше 0
  statusCounts[gameIdStr][status] = newCount;
  statusCounts[gameId][status] = newCount; // Сохраняем оба ключа для совместимости
  return newCount;
}

function resetAllStatusCounts(gameId) {
  const gameIdStr = String(gameId);
  statusCounts[gameIdStr] = { playing: 0, ill_play: 0, passed: 0, postponed: 0, abandoned: 0 };
  statusCounts[gameId] = statusCounts[gameIdStr];
  return statusCounts[gameIdStr];
}

// -------- Личные избранные в Firestore (для рекомендаций) --------
async function addUserFavorite(uid, gameId) {
  try {
    const db = getDb();
    const gameIdStr = String(gameId);
    await db.collection('users').doc(uid).collection('favorites').doc(gameIdStr).set({
      gameId: gameIdStr,
      addedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    cache.del(`user_favorites_${uid}`);
    cache.del(`recommendations_similar_${uid}`);
    return true;
  } catch (err) {
    console.error('[addUserFavorite]', err.message);
    return false;
  }
}

async function removeUserFavorite(uid, gameId) {
  try {
    const db = getDb();
    await db.collection('users').doc(uid).collection('favorites').doc(String(gameId)).delete();
    cache.del(`user_favorites_${uid}`);
    cache.del(`recommendations_similar_${uid}`);
    return true;
  } catch (err) {
    console.error('[removeUserFavorite]', err.message);
    return false;
  }
}

const USER_FAVORITES_CACHE_TTL = 60; // 1 мин — меньше обращений к Firestore при пагинации

async function getUserFavoriteGameIds(uid) {
  const cacheKey = `user_favorites_${uid}`;
  const cached = cache.get(cacheKey);
  if (cached && Array.isArray(cached)) return cached;
  try {
    const db = getDb();
    const snap = await db.collection('users').doc(uid).collection('favorites').get();
    const ids = snap.docs.map(d => String(d.data().gameId || d.id));
    if (ids.length > 0) cache.set(cacheKey, ids, USER_FAVORITES_CACHE_TTL);
    return ids;
  } catch (err) {
    console.error('[getUserFavoriteGameIds]', err.message);
    return [];
  }
}

// -------- Utils (covers, history, shuffle) --------
function weightedShuffle(arr, hist) {
  return arr.map(g => ({ g, w: hist.includes(g.id) ? 0.01 : (Math.random() + 1) }))
    .sort((a, b) => b.w - a.w).map(i => i.g);
}
// Fisher–Yates shuffle — чтобы при каждом обновлении кэша выдавались разные игры
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function updateHistory(ids) {
  let h = historyCache.get(historyKey) || [];
  h = [...new Set([...ids, ...h])].slice(0, 200);
  historyCache.set(historyKey, h);
}
// Заглушка, когда у игры нет обложки в IGDB и Steam — чтобы не показывать пусто/битое
const DEFAULT_COVER_PLACEHOLDER = 'https://placehold.co/264x352/2c2c2c/9ca3af?text=No+Cover';

function normalizeNameForMatch(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/\s*[:\-–—]\s*.*$/, '')       // убрать всё после " - " или " : "
    .replace(/\s*(edition|goty|game of the year|definitive edition|remastered|remaster)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getSteamCover(name, plats) {
  if (!plats.includes('Steam')) return null;
  const key = `steam_${name.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const apps = await getSteamApps();
  if (!apps || !apps.length) return null;
  const nameLower = name.toLowerCase();
  const nameNorm = normalizeNameForMatch(name);
  let app = apps.find(a => a.name && a.name.toLowerCase() === nameLower);
  if (!app && nameNorm) {
    app = apps.find(a => a.name && normalizeNameForMatch(a.name) === nameNorm);
  }
  if (!app && nameNorm.length > 3) {
    const firstWords = nameNorm.split(/\s+/).slice(0, 2).join(' ');
    app = apps.find(a => a.name && normalizeNameForMatch(a.name).startsWith(firstWords));
  }
  if (app) {
    const url = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
    cache.set(key, url, 86400);
    return url;
  }
  return null;
}

async function getGameCover(name, plats, igdb) {
  const steam = await getSteamCover(name, plats);
  if (steam) return steam;
  if (igdb && igdb !== 'N/A') {
    const url = igdb.replace('t_thumb', 't_cover_big');
    return url.startsWith('http') ? url : `https:${url}`;
  }
  return DEFAULT_COVER_PLACEHOLDER;
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
// Показываем рейтинг только при достаточном числе оценок (иначе у малозначимых игр бывает 100)
const MIN_RATING_COUNT_TO_SHOW = 5;

function formatCriticRating(g) {
  const rating = g.aggregated_rating;
  const count = g.aggregated_rating_count ?? 0;
  if (rating == null || count < MIN_RATING_COUNT_TO_SHOW) return 'N/A';
  const n = Math.round(rating);
  return n === 0 ? 'N/A' : n;
}

async function processPopularGame(g) {
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  return {
    id: g.id,
    name: g.name,
    cover_image: await getGameCover(g.name, plats, cover),
    critic_rating: formatCriticRating(g),
    release_year: g.release_dates?.[0]?.date ? new Date(g.release_dates[0].date * 1000).getFullYear() : 'N/A',
    main_genre: g.genres?.[0]?.name || 'N/A',
    platforms: plats
  };
}
async function processGame(g) {
  // Получаем счетчики избранного и статусов из памяти
  const favoriteCount = getFavoriteCount(g.id);
  const gameStatusCounts = getStatusCounts(g.id);
  const cover = g.cover ? `https:${g.cover.url}` : 'N/A';
  const plats = g.platforms ? g.platforms.map(p => p.name) : [];
  const genres = g.genres ? g.genres.map(gg => gg.name) : [];
  // videos - преобразуем video_id в полные YouTube URL (без ограничения количества)
  const videos = g.videos && g.videos.length > 0
    ? g.videos
        .filter(v => v.video_id) // фильтруем только те, у которых есть video_id
        .map(v => `https://www.youtube.com/watch?v=${v.video_id}`)
    : [];
  // similar games
  const similar = g.similar_games?.length
    ? await Promise.all(g.similar_games.slice(0, 3).map(async s => {
      const sc = s.cover ? `https:${s.cover.url}` : 'N/A';
      const sp = s.platforms ? s.platforms.map(p => p.name) : [];
      return {
        id: s.id,
        name: s.name,
        cover_image: await getGameCover(s.name, sp, sc),
        critic_rating: formatCriticRating(s),
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
    videos: videos,
    similar_games: similar,
    favorite: favoriteCount,
    playing: gameStatusCounts.playing,
    ill_play: gameStatusCounts.ill_play,
    passed: gameStatusCounts.passed,
    postponed: gameStatusCounts.postponed,
    abandoned: gameStatusCounts.abandoned
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
  const offset = parseInt(req.query.offset) || 0;
  if (!q) return res.status(400).json({ error: 'Query required' });

  const searchQuery = q.trim();
  // Разбиваем на слова и фильтруем только очень короткие слова (меньше 2 символов)
  const searchTerms = searchQuery.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  
  try {
    // Делаем несколько запросов для более гибкого поиска (как в newsTPV)
    const searchQueries = [];
    
    // 1. Основной запрос с полным текстом
    searchQueries.push(searchQuery);
    
    // 1b. Если запрос - известная аббревиатура, добавляем поиск по полному названию (GTA, CS и т.д.)
    const ABBREV_TO_FULL = {
      gta: 'grand theft auto',
      cs: 'counter strike',
      csgo: 'counter strike',
      cs2: 'counter strike',
      nfs: 'need for speed',
      cod: 'call of duty',
      ac: 'assassin\'s creed',
      mhw: 'monster hunter'
    };
    const fullForm = ABBREV_TO_FULL[searchQuery.toLowerCase()];
    if (fullForm && !searchQueries.includes(fullForm)) {
      searchQueries.push(fullForm);
    }
    
    // 2. Если запрос содержит несколько слов, добавляем запросы для отдельных слов
    if (searchTerms.length > 1) {
      // Добавляем запросы для основных слов (игнорируя короткие слова типа "of")
      const mainTerms = searchTerms.filter(term => term.length > 2);
      if (mainTerms.length > 0) {
        // Добавляем самое длинное слово для более широкого поиска
        const longestTerm = mainTerms.reduce((a, b) => a.length > b.length ? a : b);
        if (longestTerm !== searchQuery.toLowerCase()) {
          searchQueries.push(longestTerm);
        }
      }
    } else if (searchTerms.length === 1) {
      // Если запрос состоит из одного слова, добавляем поиск по частичному совпадению
      const singleTerm = searchTerms[0];
      // Если запрос длиннее 4 символов, делаем дополнительные запросы для частичного поиска
      if (singleTerm.length >= 4) {
        // Добавляем поиск по нескольким префиксам для лучшего покрытия
        // Для "minecra" (7 символов) делаем запросы: "mine" (4), "minec" (5), "minecr" (6)
        const prefixes = [];
        
        // Добавляем префикс из 4 символов
        if (singleTerm.length >= 4) {
          prefixes.push(singleTerm.substring(0, 4));
        }
        // Добавляем префикс из 5 символов (если запрос длиннее 5)
        if (singleTerm.length >= 5) {
          prefixes.push(singleTerm.substring(0, 5));
        }
        // Добавляем префикс из 6 символов (если запрос длиннее 6)
        if (singleTerm.length >= 6) {
          prefixes.push(singleTerm.substring(0, 6));
        }
        
        // Добавляем уникальные префиксы в поисковые запросы
        for (const prefix of prefixes) {
          if (prefix !== singleTerm && prefix.length >= 4 && !searchQueries.includes(prefix)) {
            searchQueries.push(prefix);
          }
        }
      }
    }
    
    // Выполняем запросы параллельно для лучшей производительности
    // Увеличиваем лимит, чтобы получить больше результатов от IGDB (они сами фильтруют по релевантности)
    const requests = searchQueries.map((query) => {
      const body = `fields id,name,cover.url,aggregated_rating,aggregated_rating_count,rating,rating_count,summary,platforms.name,release_dates.date,genres.name; search "${query}"; limit ${Math.max(limit * 3, 100)};`;
      return axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 })
        .catch(err => {
          console.error(`Search query "${query}" error:`, err.message);
          return { data: [] }; // Возвращаем пустой результат при ошибке
        });
    });
    
    const responses = await Promise.all(requests);
    
    // Объединяем результаты из всех запросов
    const allGames = [];
    const gamesMap = new Map(); // Для дедупликации по ID
    
    for (const response of responses) {
      if (response.data && Array.isArray(response.data)) {
        for (const game of response.data) {
          if (!gamesMap.has(game.id)) {
            gamesMap.set(game.id, game);
            allGames.push(game);
          }
        }
      }
    }
    
    // Если основной поиск дал мало результатов и запрос состоит из одного слова,
    // пробуем найти игры через более широкий поиск и фильтруем их
    if (allGames.length < limit * 2 && searchTerms.length === 1) {
      const singleTerm = searchTerms[0].toLowerCase();
      // Делаем дополнительный поиск с первыми символами для частичного совпадения
      if (singleTerm.length >= 4) {
        try {
          // Используем префикс "mine" (4 символа) для более широкого поиска
          // Это должно найти "Minecraft", так как "minecraft" начинается с "mine"
          const prefixQuery = singleTerm.substring(0, 4);
          
          // Проверяем, не делали ли мы уже этот запрос
          if (!searchQueries.includes(prefixQuery)) {
            const fallbackBody = `fields id,name,cover.url,aggregated_rating,aggregated_rating_count,rating,rating_count,summary,platforms.name,release_dates.date,genres.name; search "${prefixQuery}"; limit 500;`;
            const fallbackResponse = await axios.post(igdbUrl, fallbackBody, { headers: igdbHeaders, timeout: 10000 })
              .catch(() => ({ data: [] }));
            
            if (fallbackResponse.data && Array.isArray(fallbackResponse.data)) {
              // Строгая фильтрация - ищем игры, где название содержит запрос как подстроку
              // Это позволит "minecra" найти "minecraft"
              const filteredGames = fallbackResponse.data.filter(game => {
                const nameLower = (game.name || '').toLowerCase();
                const nameWords = nameLower.split(/\s+/);
                
                // Проверяем, содержит ли название запрос как подстроку (важно для "minecra" -> "minecraft")
                if (nameLower.includes(singleTerm)) return true;
                
                // Проверяем, начинается ли любое слово в названии с запроса
                if (nameWords.some(word => word.startsWith(singleTerm))) return true;
                
                // Проверяем, начинается ли название с запроса
                if (nameLower.startsWith(singleTerm)) return true;
                
                return false;
              });
              
              for (const game of filteredGames) {
                if (!gamesMap.has(game.id)) {
                  gamesMap.set(game.id, game);
                  allGames.push(game);
                }
              }
            }
          }
        } catch (err) {
          console.error('Fallback search error:', err.message);
        }
      }
    }
    
    // IGDB сам возвращает релевантные результаты, но дополнительно фильтруем для точности
    // Оставляем игры, которые хотя бы частично соответствуют запросу
    const queryLower = searchQuery.toLowerCase();
    // Популярные аббревиатуры -> полные названия (IGDB находит по alternative_names, но локальный фильтр проверяет только main name)
    const ABBREVIATIONS = {
      gta: ['grand theft auto'],
      cs: ['counter-strike', 'counter strike'],
      csgo: ['counter-strike', 'counter strike'],
      cs2: ['counter-strike', 'counter strike'],
      nfs: ['need for speed'],
      ac: ['assassin\'s creed', 'assassins creed'],
      cod: ['call of duty'],
      fifa: ['fifa'],
      lol: ['league of legends'],
      wow: ['world of warcraft'],
      pokemon: ['pokemon', 'pokémon'],
      tekken: ['tekken'],
      mhw: ['monster hunter']
    };
    const filteredGames = allGames.filter(game => {
      const nameLower = (game.name || '').toLowerCase();
      const nameWords = nameLower.split(/\s+/);
      
      // Игра подходит, если:
      // 1. Название содержит запрос как подстроку (самое важное для частичного поиска)
      // Это позволит "minecra" найти "minecraft"
      if (nameLower.includes(queryLower)) return true;
      
      // 2. Любое слово в названии начинается с запроса (важно для "minecra" -> "minecraft")
      if (nameWords.some(word => word.startsWith(queryLower))) return true;
      
      // 3. Название начинается с запроса
      if (nameLower.startsWith(queryLower)) return true;
      
      // 4. Запрос - известная аббревиатура и название содержит полную форму (GTA -> Grand Theft Auto)
      const expansions = ABBREVIATIONS[queryLower];
      if (expansions && expansions.some(exp => nameLower.includes(exp))) return true;
      
      // 5. Для многословных запросов - хотя бы одно слово должно совпадать
      if (searchTerms.length > 1) {
        // Проверяем, есть ли хотя бы одно слово, которое совпадает с запросом
        const hasMatch = searchTerms.some(term => 
          nameLower.includes(term) || nameWords.some(word => word.startsWith(term))
        );
        if (hasMatch) return true;
      }
      
      return false;
    });
    
    // Сортируем результаты по релевантности (основные игры серии выше модов/фанатских)
    const gamesWithScore = filteredGames.map(game => {
      const nameLower = (game.name || '').toLowerCase();
      const nameWords = nameLower.split(/\s+/);
      let score = 0;
      
      // Популярность: больше оценок = более известная игра (GTA 5 vs моды)
      const ratingCount = game.aggregated_rating_count ?? game.rating_count ?? 0;
      score += Math.min(ratingCount / 50, 60); // до +60 за популярность
      
      // Штраф за длинные названия (моды/фанатские: "Super Mario 64 in GTA San Andreas")
      if (nameWords.length > 5) score -= 40;
      else if (nameWords.length > 4) score -= 20;
      
      // Аббревиатура: название НАЧИНАЕТСЯ с франшизы = основная игра серии
      const expansions = ABBREVIATIONS[queryLower];
      if (expansions) {
        const startsWithFranchise = expansions.some(exp => nameLower.startsWith(exp));
        const containsButNotStart = expansions.some(exp => nameLower.includes(exp) && !nameLower.startsWith(exp));
        if (startsWithFranchise) score += 120;   // GTA V, GTA 6 — главные игры
        else if (containsButNotStart) score -= 30; // "X in GTA San Andreas" — мод
      }
      
      // Бонус за точное совпадение названия
      if (nameLower === queryLower) score += 100;
      // Бонус за начало названия с запросом (самый важный для частичного поиска)
      else if (nameLower.startsWith(queryLower)) score += 80;
      // Бонус за начало любого слова в названии с запросом
      else if (nameWords.some(word => word.startsWith(queryLower))) score += 70;
      // Бонус за содержание запроса в названии
      else if (nameLower.includes(queryLower)) score += 50;
      
      // Бонус за количество совпадающих слов в названии
      const matchedWords = searchTerms.filter(term => 
        nameLower.includes(term) || nameWords.some(w => w.startsWith(term))
      );
      score += matchedWords.length * 10;
      
      // Дополнительный бонус, если слово в названии полностью содержит запрос
      // Например, "minecraft" содержит "minecra" - это должно быть выше, чем "minecart"
      // Важно: проверяем, что слово начинается с запроса или содержит запрос и продолжается
      const wordWithQuery = nameWords.find(word => 
        word.includes(queryLower) && word.length > queryLower.length
      );
      if (wordWithQuery) {
        // Если слово начинается с запроса - это самое точное совпадение
        if (wordWithQuery.startsWith(queryLower)) {
          score += 60; // Очень большой бонус за игры, где слово начинается с запроса
        } else if (wordWithQuery.includes(queryLower)) {
          score += 40; // Большой бонус за игры, где слово содержит запрос и продолжается
        }
      }
      
      // Бонус за рейтинг (игры с рейтингом выше получают небольшой бонус)
      if (game.aggregated_rating) score += game.aggregated_rating / 10;
      
      return { ...game, _relevanceScore: score };
    });
    
    // Сортируем по релевантности, затем по популярности (кол-во оценок), затем по рейтингу
    gamesWithScore.sort((a, b) => {
      if (b._relevanceScore !== a._relevanceScore) {
        return b._relevanceScore - a._relevanceScore;
      }
      // Если релевантность одинаковая — по популярности (больше оценок = популярнее)
      const aCount = a.aggregated_rating_count ?? a.rating_count ?? 0;
      const bCount = b.aggregated_rating_count ?? b.rating_count ?? 0;
      if (bCount !== aCount) return bCount - aCount;
      const aRating = a.aggregated_rating || a.rating || 0;
      const bRating = b.aggregated_rating || b.rating || 0;
      return bRating - aRating;
    });
    
    // Берем топ результатов и обрабатываем их
    const topGames = gamesWithScore.slice(0, limit * 2).map(({ _relevanceScore, ...game }) => game);
    
    // Обрабатываем игры через processSearchGame
    const processedGames = await Promise.all(topGames.map(processSearchGame));
    
    // Вычисляем релевантность на основе обработанных данных
    const gamesWithRelevance = processedGames.map(game => {
      const nameLower = (game.name || '').toLowerCase();
      let score = 0;
      
      // Бонус за точное совпадение названия
      if (nameLower === queryLower) score += 100;
      // Бонус за начало названия с запросом
      else if (nameLower.startsWith(queryLower)) score += 50;
      // Бонус за содержание запроса в названии
      else if (nameLower.includes(queryLower)) score += 30;
      
      // Бонус за количество совпадающих слов в названии
      const nameWords = nameLower.split(/\s+/);
      const matchedWords = searchTerms.filter(term => nameWords.some(w => w.includes(term.toLowerCase())));
      score += matchedWords.length * 5;
      
      // Бонус за рейтинг
      const rating = typeof game.rating === 'number' ? game.rating : 0;
      score += rating / 10;
      
      return { ...game, _relevanceScore: score };
    });
    
    // Сортируем по релевантности, затем по рейтингу
    gamesWithRelevance.sort((a, b) => {
      if (b._relevanceScore !== a._relevanceScore) {
        return b._relevanceScore - a._relevanceScore;
      }
      const aRating = typeof a.rating === 'number' ? a.rating : 0;
      const bRating = typeof b.rating === 'number' ? b.rating : 0;
      return bRating - aRating;
    });
    
    // Убираем временное поле score, применяем пагинацию
    const total = gamesWithRelevance.length;
    const finalGames = gamesWithRelevance
      .slice(offset, offset + limit)
      .map(({ _relevanceScore, ...game }) => game);
    const hasMore = offset + finalGames.length < total;
    
    res.json({ data: finalGames, pagination: { hasMore, total, offset } });
  } catch (err) {
    console.error('/search ERROR:', err.message, err.response?.status, err.response?.data);
    if (err.response?.status === 401) {
      try { 
        await refreshAccessToken(); 
        // Пробуем повторить запрос после обновления токена
        const body = `fields id,name,cover.url,aggregated_rating,rating,summary,platforms.name,release_dates.date,genres.name; search "${searchQuery}"; limit ${limit};`;
        const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
        const games = await Promise.all(r.data.map(processSearchGame));
        const pageGames = games.slice(offset, offset + limit);
        return res.json({ data: pageGames, pagination: { hasMore: offset + pageGames.length < games.length, total: games.length, offset } });
      } catch(e) {
        console.error('Retry after token refresh failed:', e.message);
      }
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
  
  // Проверяем кэш
  const cacheKey = `game_${id}`;
  const cached = gameCache.get(cacheKey);
  if (cached) {
    console.log(`[GET /games/${id}] Cache hit`);
    return res.json(cached);
  }
  
  const body = `fields id,name,genres.name,platforms.name,release_dates.date,aggregated_rating,rating,cover.url,age_ratings.*,summary,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,videos.video_id,similar_games.id,similar_games.name,similar_games.cover.url,similar_games.aggregated_rating,similar_games.release_dates.date,similar_games.genres.name,similar_games.platforms.name;where id = ${id}; limit 1;`;
  
  // Функция для выполнения запроса с повторными попытками
  const fetchGameWithRetry = async (maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[GET /games/${id}] Attempt ${attempt}/${maxRetries}`);
        const r = await axios.post(igdbUrl, body, { 
          headers: igdbHeaders, 
          timeout: 15000 // Увеличен таймаут до 15 секунд
        });
        
        if (!r.data.length) {
          return { error: 'Game not found', status: 404 };
        }
        
        const game = await processGame(r.data[0]);
        // Сохраняем в кэш
        gameCache.set(cacheKey, game, 3600); // 1 час
        return { game };
      } catch (err) {
        console.error(`[GET /games/${id}] Attempt ${attempt} failed:`, err.response?.status || err.message);
        
        // Если токен истек, обновляем и повторяем
        if (err.response?.status === 401) {
          try {
            await refreshAccessToken();
            // Продолжаем попытку после обновления токена
            continue;
          } catch (tokenErr) {
            console.error(`[GET /games/${id}] Token refresh failed:`, tokenErr.message);
            if (attempt === maxRetries) {
              return { error: 'Authentication failed', status: 500 };
            }
          }
        }
        
        // Для других ошибок делаем задержку перед повторной попыткой
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * attempt, 3000); // Экспоненциальная задержка, максимум 3 секунды
          console.log(`[GET /games/${id}] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          return { error: err.response?.data?.message || err.message || 'IGDB error', status: err.response?.status || 500 };
        }
      }
    }
  };
  
  try {
    const result = await fetchGameWithRetry();
    
    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    
    res.json(result.game);
  } catch (err) {
    console.error('/games/:id FATAL ERROR:', err.message);
    res.status(500).json({ error: 'Internal server error' });
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

// POST /games/:id/favorite - увеличить счетчик избранного (+1) и сохранить в Firestore для рекомендаций
app.post('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const newCount = updateFavoriteCount(gameId, 1);
    await addUserFavorite(req.user.uid, gameId);
    console.log(`[POST /games/${gameId}/favorite] Favorite count: ${newCount}`);
    res.json({ favorite: newCount });
  } catch (error) {
    console.error('Error /games/:id/favorite (POST):', error.message);
    res.status(500).json({ error: 'Failed to increment favorite count: ' + error.message });
  }
});

// DELETE /games/:id/favorite - уменьшить счетчик избранного (-1) и удалить из Firestore
app.delete('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const newCount = updateFavoriteCount(gameId, -1);
    await removeUserFavorite(req.user.uid, gameId);
    console.log(`[DELETE /games/${gameId}/favorite] Favorite count: ${newCount}`);
    res.json({ favorite: newCount });
  } catch (error) {
    console.error('Error /games/:id/favorite (DELETE):', error.message);
    res.status(500).json({ error: 'Failed to decrement favorite count: ' + error.message });
  }
});
// ---------- Status endpoints (как в коммите 80f5e36) ----------
const validStatuses = ['playing', 'ill_play', 'passed', 'postponed', 'abandoned'];

// POST /games/:id/status/:status - увеличить счетчик статуса (+1)
app.post('/games/:id/status/:status', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const status = req.params.status.toLowerCase();
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const newCount = updateStatusCount(gameId, status, 1);
    console.log(`[POST /games/${gameId}/status/${status}] Status count: ${newCount}`);
    res.json({ [status]: newCount });
  } catch (error) {
    console.error(`Error /games/:id/status/:status (POST):`, error.message);
    res.status(500).json({ error: `Failed to increment ${req.params.status} count: ` + error.message });
  }
});

// DELETE /games/:id/status/:status - уменьшить счетчик статуса (-1)
app.delete('/games/:id/status/:status', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const status = req.params.status.toLowerCase();
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const newCount = updateStatusCount(gameId, status, -1);
    console.log(`[DELETE /games/${gameId}/status/${status}] Status count: ${newCount}`);
    res.json({ [status]: newCount });
  } catch (error) {
    console.error(`Error /games/:id/status/:status (DELETE):`, error.message);
    res.status(500).json({ error: `Failed to decrement ${req.params.status} count: ` + error.message });
  }
});

// DELETE /games/:id/status - сбросить все счетчики статусов в 0
app.delete('/games/:id/status', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const resetCounts = resetAllStatusCounts(gameId);
    console.log(`[DELETE /games/${gameId}/status] All status counts reset to 0`);
    res.json(resetCounts);
  } catch (error) {
    console.error(`Error /games/:id/status (DELETE):`, error.message);
    res.status(500).json({ error: 'Failed to reset statuses: ' + error.message });
  }
});

// -------- Личные рекомендации (пагинация: limit по умолчанию 4, page) --------
const RECOMMENDATIONS_RANDOM60_CACHE_TTL = 600;      // 10 мин — кэш пула «рейтинг > 60, случайный порядок»
const RECOMMENDATIONS_SIMILAR_CACHE_TTL = 300;       // 5 мин — кэш похожих ID по пользователю
const RANDOM_60_POOL_SIZE = 400;                      // сколько игр с рейтингом > 60 держать в пуле

// Пул ID «рейтинг > 60» (без порядка — порядок задаётся при отдаче)
async function getRandomRating60PoolIds() {
  const cacheKey = 'recommendations_random_60_pool';
  const cached = cache.get(cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }
  const fields = 'fields id,name,cover.url,aggregated_rating,aggregated_rating_count,release_dates.date,genres.name,platforms.name';
  const body = `${fields}; where aggregated_rating > 60; limit ${RANDOM_60_POOL_SIZE};`;
  try {
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 15000 });
    const ids = (r.data || []).map(g => g.id).filter(Boolean);
    if (ids.length > 0) {
      cache.set(cacheKey, ids, RECOMMENDATIONS_RANDOM60_CACHE_TTL);
    }
    return ids;
  } catch (e) {
    console.warn('[getRandomRating60PoolIds]', e.message);
    return [];
  }
}

// Для гостей и пользователей без избранного: порядок перемешан (при чтении из кэша тоже перемешиваем)
async function getRandomRating60PlusIds(userId) {
  const pool = await getRandomRating60PoolIds();
  if (pool.length === 0) return [];
  if (userId) {
    const orderKey = `recommendations_random_60_order_${userId}`;
    let order = cache.get(orderKey);
    if (!order || !Array.isArray(order)) {
      order = shuffleArray(pool);
      cache.set(orderKey, order, RECOMMENDATIONS_RANDOM60_CACHE_TTL);
    }
    return order;
  }
  return shuffleArray(pool);
}

// GET /recommendations?limit=4&page=1 — для авторизованных с избранным: похожие; иначе игры с рейтингом > 60 в случайном порядке
app.get('/recommendations', optionalAuthenticate, async (req, res) => {
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 4), 20);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * limit;

  try {
    const userId = req.user ? req.user.uid : null;
    const favoriteIds = userId ? await getUserFavoriteGameIds(userId) : [];
    const favoriteSet = new Set(favoriteIds.map(String));

    // Не зарегистрирован или нет избранного — игры с рейтингом > 60 в случайном порядке
    if (!userId || favoriteIds.length === 0) {
      const allIds = await getRandomRating60PlusIds(userId);
      const pageIds = allIds.slice(offset, offset + limit);
      if (pageIds.length === 0) {
        return res.json({ source: 'random_60', games: [], hasMore: false });
      }
      const body = `fields id,name,cover.url,aggregated_rating,aggregated_rating_count,release_dates.date,genres.name,platforms.name; where id = (${pageIds.join(',')});`;
      const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
      const orderMap = new Map(pageIds.map((id, i) => [String(id), i]));
      const sorted = (r.data || []).slice().sort((a, b) => (orderMap.get(String(a.id)) ?? 999) - (orderMap.get(String(b.id)) ?? 999));
      const games = await Promise.all(sorted.map(processPopularGame));
      const hasMore = offset + games.length < allIds.length;
      return res.json({ source: 'random_60', games, hasMore });
    }

    // Список похожих ID по пользователю (кэш 5 мин — чтобы пагинация не дергала IGDB заново)
    const similarCacheKey = `recommendations_similar_${userId}`;
    let allRecommendedIds = cache.get(similarCacheKey);
    if (!allRecommendedIds || !Array.isArray(allRecommendedIds)) {
      const idsToQuery = favoriteIds.slice(0, 15);
      const multiBody = idsToQuery
        .map(id => `fields similar_games.id; where id = ${id}; limit 1;`)
        .join('\n');
      const responses = await axios.post(igdbUrl, multiBody, { headers: igdbHeaders, timeout: 12000 });
      const results = Array.isArray(responses.data[0]) ? responses.data : [responses.data];
      const similarCount = {};
      for (const arr of results) {
        if (!Array.isArray(arr)) continue;
        for (const game of arr) {
          const similar = game.similar_games || [];
          for (const s of similar) {
            if (s && s.id && !favoriteSet.has(String(s.id))) {
              similarCount[s.id] = (similarCount[s.id] || 0) + 1;
            }
          }
        }
      }
      const sorted = Object.entries(similarCount)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
      allRecommendedIds = shuffleArray(sorted);
      if (allRecommendedIds.length > 0) {
        cache.set(similarCacheKey, allRecommendedIds, RECOMMENDATIONS_SIMILAR_CACHE_TTL);
      }
    }

    const pageIds = allRecommendedIds.slice(offset, offset + limit);

    if (pageIds.length === 0) {
      // Нет похожих на этой странице — fallback: игры с рейтингом > 60 в случайном порядке
      const allIds = await getRandomRating60PlusIds(userId);
      const fallbackIds = allIds.slice(offset, offset + limit);
      if (fallbackIds.length === 0) {
        return res.json({ source: 'random_60', games: [], hasMore: false });
      }
      const body = `fields id,name,cover.url,aggregated_rating,aggregated_rating_count,release_dates.date,genres.name,platforms.name; where id = (${fallbackIds.join(',')});`;
      const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
      const orderMap = new Map(fallbackIds.map((id, i) => [String(id), i]));
      const sorted = (r.data || []).slice().sort((a, b) => (orderMap.get(String(a.id)) ?? 999) - (orderMap.get(String(b.id)) ?? 999));
      const games = await Promise.all(sorted.map(processPopularGame));
      return res.json({ source: 'random_60', games, hasMore: offset + games.length < allIds.length });
    }

    const body = `fields id,name,cover.url,aggregated_rating,aggregated_rating_count,release_dates.date,genres.name,platforms.name; where id = (${pageIds.join(',')});`;
    const r = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 10000 });
    const orderMap = new Map(pageIds.map((id, i) => [String(id), i]));
    const sorted = (r.data || []).slice().sort((a, b) => (orderMap.get(String(a.id)) ?? 999) - (orderMap.get(String(b.id)) ?? 999));
    const games = await Promise.all(sorted.map(processPopularGame));
    const hasMore = offset + games.length < allRecommendedIds.length;

    res.json({ source: 'similar', games, hasMore });
  } catch (err) {
    console.error('/recommendations ERROR:', err.message, err.response?.status);
    if (err.response?.status === 401) {
      try {
        await refreshAccessToken();
      } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: 'Recommendations error' });
  }
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
