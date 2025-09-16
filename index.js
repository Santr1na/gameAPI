const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const NodeCache = require('node-cache');
const cron = require('node-cron');
const admin = require('firebase-admin'); // Добавляем Firebase Admin SDK
const app = express();
const port = process.env.PORT || 3000;

// Инициализация Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); // Убедитесь, что переменная окружения содержит JSON-ключи
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Конфигурация кэша
const cache = new NodeCache({ stdTTL: 86400 }); // 24 часа
const historyCache = new NodeCache({ stdTTL: 604800 }); // 7 дней
const historyKey = 'recent_games';

// Пути к файлам
const favoriteCountsFile = path.join(__dirname, 'favorite_counts.json');
const statusCountsFile = path.join(__dirname, 'status_counts.json');

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'images')));

// Конфигурация IGDB
const clientId = '6suowimw8bemqf3u9gurh7qnpx74sd';
const accessToken = 'q4hi62k3igoelslpmuka0vw2uwz8gv';
const igdbUrl = 'https://api.igdb.com/v4/games';
const steamUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
const igdbHeaders = { 'Client-ID': clientId, 'Authorization': `Bearer ${accessToken}` };

// Middleware для проверки авторизации
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Сохраняем данные пользователя для последующей обработки
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
    const response = await axios.post(igdbUrl, 'fields id, name, cover.url, aggregated_rating; where aggregated_rating >= 80 & aggregated_rating_count > 5; limit 1;', {
      headers: igdbHeaders,
      timeout: 5000,
    });
    if (response.data.length > 0) {
      console.log('Scheduled fetch of popular games completed:', response.data.length, 'items');
    }
  } catch (error) {
    console.error('Error during scheduled fetch of popular games:', error.message);
  }
}, {
  scheduled: true,
  timezone: 'Europe/Kiev',
});

// Загрузка и сохранение данных
async function loadFavoriteCounts() {
  try {
    const data = await fs.readFile(favoriteCountsFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error('Error loading favorite counts:', error.message);
    return {};
  }
}

async function saveFavoriteCounts(counts) {
  try {
    await fs.mkdir(path.dirname(favoriteCountsFile), { recursive: true });
    await fs.writeFile(favoriteCountsFile, JSON.stringify(counts, null, 2));
  } catch (error) {
    console.error('Error saving favorite counts:', error.message);
  }
}

async function loadStatusCounts() {
  try {
    const data = await fs.readFile(statusCountsFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error('Error loading status counts:', error.message);
    return {};
  }
}

async function saveStatusCounts(counts) {
  try {
    await fs.mkdir(path.dirname(statusCountsFile), { recursive: true });
    await fs.writeFile(statusCountsFile, JSON.stringify(counts, null, 2));
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

async function enhanceImage(imageUrl) {
  if (!imageUrl || imageUrl === 'N/A') return imageUrl;
  const cached = cache.get(imageUrl);
  if (cached) return cached;
  try {
    const imageResponse = await axios.get(imageUrl.replace('t_thumb', 't_cover_big'), {
      responseType: 'arraybuffer',
      timeout: 5000,
    });
    const imageBuffer = Buffer.from(imageResponse.data);
    const outputDir = path.join(__dirname, 'images');
    await fs.mkdir(outputDir, { recursive: true });
    const outputFilename = `enhanced_${path.basename(imageUrl)}`.replace(/[^a-zA-Z0-9.]/g, '_');
    const outputPath = path.join(outputDir, outputFilename);
    await sharp(imageBuffer)
      .resize({ width: 800, height: 1200, fit: 'inside', kernel: 'lanczos3' })
      .toFormat('jpeg', { quality: 85 })
      .toFile(outputPath);
    const enhancedUrl = `/images/${outputFilename}`;
    cache.set(imageUrl, enhancedUrl);
    return enhancedUrl;
  } catch (error) {
    console.error(`Image enhancement error for ${imageUrl}: ${error.message}`);
    return imageUrl.replace('t_thumb', 't_cover_big');
  }
}

async function getSteamCover(gameName, platforms) {
  if (!platforms.includes('Steam')) return null;
  const cacheKey = `steam_${gameName.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const steamResponse = await axios.get(steamUrl, { timeout: 5000 });
    const app = steamResponse.data.applist.apps.find((a) => a.name.toLowerCase() === gameName.toLowerCase());
    if (app) {
      const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
      cache.set(cacheKey, coverUrl, 86400);
      return coverUrl;
    }
    return null;
  } catch (error) {
    console.error(`Steam cover error for ${gameName}: ${error.message}`);
    return null;
  }
}

async function getGameCover(gameName, platforms, igdbCover) {
  const [steamCover] = await Promise.all([getSteamCover(gameName, platforms)]);
  return steamCover || (igdbCover !== 'N/A' ? await enhanceImage(igdbCover) : igdbCover);
}

async function processShortGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map((p) => p.name) : ['N/A'];
  return {
    id: game.id,
    name: game.name,
    cover_image: await getGameCover(game.name, platforms, coverImage),
    critic_rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : 'N/A',
    release_year: game.release_dates?.[0]?.date ? new Date(game.release_dates[0].date * 1000).getFullYear() : 'N/A',
    main_genre: game.genres?.[0]?.name || 'N/A',
    platforms,
  };
}

async function processGame(game) {
  const favoriteCounts = await loadFavoriteCounts();
  const statusCounts = await loadStatusCounts();
  const gameStatusCounts = statusCounts[game.id] || {};
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map((p) => p.name) : ['N/A'];
  const genres = game.genres ? game.genres.map((g) => g.name) : ['N/A'];
  const summary = game.summary || 'N/A';
  const similarGames = game.similar_games?.length
    ? await Promise.all(
        game.similar_games.slice(0, 3).map(async (s) => {
          const similarCoverImage = s.cover ? `https:${s.cover.url}` : 'N/A';
          const similarPlatforms = s.platforms ? s.platforms.map((p) => p.name) : ['N/A'];
          return {
            id: s.id,
            name: s.name,
            cover_image: await getGameCover(s.name, similarPlatforms, similarCoverImage),
            critic_rating: s.aggregated_rating ? Math.round(s.aggregated_rating) : 'N/A',
            release_year: s.release_dates?.[0]?.date ? new Date(s.release_dates[0].date * 1000).getFullYear() : 'N/A',
            main_genre: s.genres?.[0]?.name || 'N/A',
            platforms: similarPlatforms,
          };
        })
      )
    : ['N/A'];
  return {
    id: game.id,
    name: game.name,
    genres,
    platforms,
    release_date: game.release_dates?.[0]?.date ? new Date(game.release_dates[0].date * 1000).toISOString().split('T')[0] : 'N/A',
    rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : game.rating ? Math.round(game.rating) : 'N/A',
    rating_type: game.aggregated_rating ? 'Critics' : game.rating ? 'Users' : 'N/A',
    cover_image: await getGameCover(game.name, platforms, coverImage),
    age_ratings: game.age_ratings
      ? game.age_ratings.map((r) => {
          const ratings = {
            1: 'ESRB: EC',
            2: 'ESRB: E',
            3: 'ESRB: E10+',
            4: 'ESRB: T',
            5: 'ESRB: M',
            6: 'ESRB: AO',
            7: 'PEGI: 3',
            8: 'PEGI: 7',
            9: 'PEGI: 12',
            10: 'PEGI: 16',
            11: 'PEGI: 18',
          };
          return ratings[r.rating] || 'N/A';
        })
      : ['N/A'],
    summary,
    developers: game.involved_companies ? game.involved_companies.map((c) => c.company.name) : ['N/A'],
    videos: game.videos ? game.videos.map((v) => `https://www.youtube.com/watch?v=${v.video_id}`).slice(0, 3) : ['N/A'],
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
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; limit 10;';
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 5000 });
    const games = await Promise.all(response.data.map((game) => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error('Error /popular:', error.message);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

app.get('/games', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * 50;
    const history = historyCache.get(historyKey) || [];
    const excludeIds = history.length > 0 ? `where id != (${history.join(',')});` : '';
    const body = `fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; ${excludeIds} limit 50; offset ${offset};`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 5000 });
    const data = response.data;
    if (!data?.length) {
      historyCache.set(historyKey, []);
      return res.status(404).json({ error: 'No new games available' });
    }
    const shuffledData = weightedShuffle(data, history);
    const selectedGames = shuffledData.slice(0, 5);
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
    const body = `fields id, name, genres.name, platforms.name, release_dates.date, aggregated_rating, rating, cover.url, age_ratings.rating, summary, involved_companies.company.name, videos.video_id, similar_games.id, similar_games.name, similar_games.cover.url, similar_games.aggregated_rating, similar_games.release_dates.date, similar_games.genres.name, similar_games.platforms.name; where id = ${gameId}; limit 1;`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 5000 });
    if (!response.data?.length) return res.status(404).json({ error: 'Game not found' });
    const game = await processGame(response.data[0]);
    res.json(game);
  } catch (error) {
    console.error('Error /games/:id:', error.message);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

// Эндпоинты с проверкой авторизации
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
const server = app.listen(port, () => {
  console.log(`Server running on port ${port} at ${new Date().toISOString()}`);
  const publicUrl = process.env.PUBLIC_URL || `https://gameapi-7i62.onrender.com`;
  console.log('Using public URL for keep-alive:', publicUrl);
  scheduleKeepAlive(publicUrl);
}).on('error', (err) => {
  console.error('Server failed to start:', err.message);
});

module.exports = app;
