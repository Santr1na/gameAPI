const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const cron = require('node-cron');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3000;
// Инициализация Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
// Конфигурация кэша
const cache = new NodeCache({ stdTTL: 86400 }); // 24 часа
const historyCache = new NodeCache({ stdTTL: 604800 }); // 7 дней
const historyKey = 'recent_games';
// Конфигурация RAWG
const rawgKey = process.env.RAWG_API_KEY;
const rawgUrl = 'https://api.rawg.io/api/games';
const steamUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
let steamApps = null;
// Функция для получения steamApps
async function getSteamApps() {
  if (steamApps) return steamApps;
  try {
    const response = await axios.get(steamUrl, { timeout: 5000 });
    steamApps = response.data.applist.apps;
    return steamApps;
  } catch (error) {
    console.error('Failed to fetch Steam app list:', error.message);
    return [];
  }
}
// Middleware для проверки авторизации
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Missing or invalid auth header');
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
}
// Механизм активности с использованием cron
function scheduleKeepAlive(publicUrl) {
  if (!publicUrl) {
    console.warn('No public URL provided for keep-alive ping. Set PUBLIC_URL environment variable.');
    return;
  }
  cron.schedule('*/10 * * * *', async () => {
    try {
      const response = await axios.get(publicUrl + '/health', { timeout: 5000 });
      if (response.status === 200) {
        console.log('Keep-alive ping successful to', publicUrl, 'at', new Date().toISOString());
      } else {
        console.warn('Keep-alive ping received non-200 status:', response.status);
      }
    } catch (error) {
      console.error('Keep-alive ping failed:', error.message, 'URL:', publicUrl);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Kiev',
  });
}
// Периодическая задача для проверки популярных игр
cron.schedule('*/10 * * * *', async () => {
  try {
    console.log('Running scheduled fetch of popular games...');
    const response = await axios.get(`${rawgUrl}?key=${rawgKey}&ordering=-metacritic&page_size=1`, { timeout: 5000 });
    if (response.data.results.length > 0) {
      console.log('Scheduled fetch of popular games completed:', response.data.results.length, 'items');
    }
  } catch (error) {
    console.error('Error during scheduled fetch of popular games:', error.message);
  }
}, {
  scheduled: true,
  timezone: 'Europe/Kiev',
});
// Загрузка и сохранение данных с Firestore
async function loadFavoriteCounts() {
  try {
    const doc = await db.collection('counters').doc('favorites').get();
    return doc.exists ? doc.data() : {};
  } catch (error) {
    console.error('Error loading favorite counts:', error.message);
    return {};
  }
}
async function saveFavoriteCounts(counts) {
  try {
    await db.collection('counters').doc('favorites').set(counts);
  } catch (error) {
    console.error('Error saving favorite counts:', error.message);
  }
}
async function loadStatusCounts() {
  try {
    const doc = await db.collection('counters').doc('statuses').get();
    return doc.exists ? doc.data() : {};
  } catch (error) {
    console.error('Error loading status counts:', error.message);
    return {};
  }
}
async function saveStatusCounts(counts) {
  try {
    await db.collection('counters').doc('statuses').set(counts);
  } catch (error) {
    console.error('Error saving status counts:', error.message);
  }
}
// Вспомогательные функции
function weightedShuffle(array, history) {
  return array
    .map((game) => ({
      game,
      weight: history.includes(game.id) ? 0.01 : 1 * (Math.random() + 1),
    }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ game }) => game);
}
function updateHistory(gameIds) {
  let history = historyCache.get(historyKey) || [];
  history = [...new Set([...gameIds, ...history])].slice(0, 200);
  historyCache.set(historyKey, history);
}
async function getSteamCover(gameName, platforms) {
  if (!platforms.includes('PC')) return null;
  const cacheKey = `steam_${gameName.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const apps = await getSteamApps();
  const app = apps.find((a) => a.name.toLowerCase() === gameName.toLowerCase());
  if (app) {
    const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
    cache.set(cacheKey, coverUrl, 86400);
    return coverUrl;
  }
  return null;
}
async function getGameCover(gameName, platforms, rawgImage) {
  const steamCover = await getSteamCover(gameName, platforms);
  return steamCover || (rawgImage || 'N/A');
}
async function processShortGame(game) {
  const platforms = game.platforms ? game.platforms.map((p) => p.platform.name) : [];
  return {
    id: game.id,
    name: game.name,
    cover_image: await getGameCover(game.name, platforms, game.background_image),
    critic_rating: game.metacritic || 'N/A',
    release_year: game.released ? new Date(game.released).getFullYear() : 'N/A',
    main_genre: game.genres?.[0]?.name || 'N/A',
    platforms,
  };
}
async function processGame(game) {
  const favoriteCounts = await loadFavoriteCounts();
  const statusCounts = await loadStatusCounts();
  const gameStatusCounts = statusCounts[game.id] || {};
  const platforms = game.platforms ? game.platforms.map((p) => p.platform.name) : [];
  const genres = game.genres ? game.genres.map((g) => g.name) : [];
  const summary = game.description_raw || 'N/A';
  const similarGames = []; // RAWG не предоставляет similar_games напрямую, можно добавить логику если нужно
  return {
    id: game.id,
    name: game.name,
    genres,
    platforms,
    release_date: game.released || 'N/A',
    rating: game.metacritic || game.rating || 'N/A',
    rating_type: game.metacritic ? 'Critics' : game.rating ? 'Users' : 'N/A',
    cover_image: await getGameCover(game.name, platforms, game.background_image),
    age_ratings: game.esrb_rating ? [game.esrb_rating.name] : ['N/A'],
    summary,
    developers: game.developers ? game.developers.map((d) => d.name) : ['N/A'],
    videos: ['N/A'], // RAWG не предоставляет videos напрямую
    similar_games: similarGames,
    favorite: favoriteCounts[game.id] || 0,
    playing: gameStatusCounts.playing || 0,
    ill_play: gameStatusCounts.ill_play || 0,
    passed: gameStatusCounts.passed || 0,
    postponed: gameStatusCounts.postponed || 0,
    abandoned: gameStatusCounts.abandoned || 0,
  };
}
// Эндпоинты
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));
app.get('/popular', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  try {
    const response = await axios.get(`${rawgUrl}?key=${rawgKey}&ordering=-metacritic&page_size=${limit}`, { timeout: 5000 });
    const games = await Promise.all(response.data.results.map((game) => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error('Error /popular:', error.message);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});
app.get('/search', async (req, res) => {
  const query = req.query.query;
  const limit = parseInt(req.query.limit) || 10;
  if (!query) return res.status(400).json({ error: 'Query required' });
  try {
    const response = await axios.get(`${rawgUrl}?key=${rawgKey}&search=${query}&ordering=-metacritic&page_size=${limit}`, { timeout: 5000 });
    const games = await Promise.all(response.data.results.map((game) => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error('Error /search:', error.message);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});
app.get('/games', async (req, res) => {
  const limit = parseInt(req.query.limit) || 5;
  try {
    const page = parseInt(req.query.page) || 1;
    const response = await axios.get(`${rawgUrl}?key=${rawgKey}&page=${page}&page_size=50`, { timeout: 5000 });
    const data = response.data.results;
    if (!data?.length) {
      return res.status(404).json({ error: 'No new games available' });
    }
    const history = historyCache.get(historyKey) || [];
    const filteredData = data.filter(game => !history.includes(game.id));
    const shuffledData = weightedShuffle(filteredData.length ? filteredData : data, history);
    const selectedGames = shuffledData.slice(0, limit);
    updateHistory(selectedGames.map((g) => g.id));
    const games = await Promise.all(selectedGames.map((game) => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error('Error /games:', error.message);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});
app.get('/games/:id', async (req, res) => {
  try {
    const gameId = req.params.id;
    const response = await axios.get(`https://api.rawg.io/api/games/${gameId}?key=${rawgKey}`, { timeout: 5000 });
    if (!response.data) return res.status(404).json({ error: 'Game not found' });
    const game = await processGame(response.data);
    res.json(game);
  } catch (error) {
    console.error('Error /games/:id:', error.message);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});
app.get('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const favoriteCounts = await loadFavoriteCounts();
    const count = favoriteCounts[gameId] || 0;
    res.json({ favorite: count });
  } catch (error) {
    console.error('Error /games/:id/favorite (GET):', error.message);
    res.status(500).json({ error: 'Failed to get favorite count' });
  }
});
app.post('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const favoriteCounts = await loadFavoriteCounts();
    favoriteCounts[gameId] = (favoriteCounts[gameId] || 0) + 1;
    await saveFavoriteCounts(favoriteCounts);
    res.json({ favorite: favoriteCounts[gameId] });
  } catch (error) {
    console.error('Error /games/:id/favorite (POST):', error.message);
    res.status(500).json({ error: 'Failed to increment favorite count: ' + error.message });
  }
});
app.delete('/games/:id/favorite', authenticate, async (req, res) => {
  try {
    const gameId = req.params.id;
    const favoriteCounts = await loadFavoriteCounts();
    favoriteCounts[gameId] = Math.max((favoriteCounts[gameId] || 0) - 1, 0);
    await saveFavoriteCounts(favoriteCounts);
    res.json({ favorite: favoriteCounts[gameId] });
  } catch (error) {
    console.error('Error /games/:id/favorite (DELETE):', error.message);
    res.status(500).json({ error: 'Failed to decrement favorite count: ' + error.message });
  }
});
const validStatuses = ['playing', 'ill_play', 'passed', 'postponed', 'abandoned'];
app.post('/games/:id/status/:status', authenticate, async (req, res) => {
  const gameId = req.params.id;
  const status = req.params.status.toLowerCase();
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const statusCounts = await loadStatusCounts();
    const gameStatusCounts = statusCounts[gameId] || {};
    gameStatusCounts[status] = (gameStatusCounts[status] || 0) + 1;
    statusCounts[gameId] = gameStatusCounts;
    await saveStatusCounts(statusCounts);
    res.json({ [status]: gameStatusCounts[status] });
  } catch (error) {
    console.error(`Error /games/:id/status/${status} (POST):`, error.message);
    res.status(500).json({ error: `Failed to increment ${status} count: ${error.message}` });
  }
});
app.delete('/games/:id/status/:status', authenticate, async (req, res) => {
  const gameId = req.params.id;
  const status = req.params.status.toLowerCase();
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const statusCounts = await loadStatusCounts();
    const gameStatusCounts = statusCounts[gameId] || {};
    gameStatusCounts[status] = Math.max((gameStatusCounts[status] || 0) - 1, 0);
    statusCounts[gameId] = gameStatusCounts;
    await saveStatusCounts(statusCounts);
    res.json({ [status]: gameStatusCounts[status] });
  } catch (error) {
    console.error(`Error /games/:id/status/${status} (DELETE):`, error.message);
    res.status(500).json({ error: `Failed to decrement ${status} count: ${error.message}` });
  }
});
app.delete('/games/:id/status', authenticate, async (req, res) => {
  const gameId = req.params.id;
  try {
    const statusCounts = await loadStatusCounts();
    const gameStatusCounts = statusCounts[gameId] || {};
    validStatuses.forEach((status) => {
      gameStatusCounts[status] = 0;
    });
    statusCounts[gameId] = gameStatusCounts;
    await saveStatusCounts(statusCounts);
    res.json({ message: 'All statuses reset to 0' });
  } catch (error) {
    console.error(`Error /games/:id/status (DELETE):`, error.message);
    res.status(500).json({ error: 'Failed to reset statuses: ' + error.message });
  }
});
// Грациозное завершение
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server terminated at', new Date().toISOString());
  });
});
// Запуск сервера
const server = app.listen(port, async () => {
  console.log(`Server running on port ${port} at ${new Date().toISOString()}`);
  const publicUrl = process.env.PUBLIC_URL || `https://gameapi-7i62.onrender.com`;
  console.log('Using public URL for keep-alive:', publicUrl);
  try {
    await getSteamApps(); // Загружаем Steam app list при старте
    scheduleKeepAlive(publicUrl);
  } catch (error) {
    console.error('Initial setup failed:', error.message);
  }
}).on('error', (err) => {
  console.error('Server failed to start:', err.message);
});
module.exports = app;
