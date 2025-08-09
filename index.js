const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 86400 }); // Кэш на 24 часа

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'images')));

const clientId = '6suowimw8bemqf3u9gurh7qnpx74sd';
const accessToken = 'q4hi62k3igoelslpmuka0vw2uwz8gv';
const igdbUrl = 'https://api.igdb.com/v4/games';
const steamUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';

const igdbHeaders = {
  'Client-ID': clientId,
  'Authorization': `Bearer ${accessToken}`,
};

// Функция для случайного перемешивания массива
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Функция для локального улучшения с Sharp
async function enhanceImage(imageUrl) {
  if (!imageUrl || imageUrl === 'N/A') return imageUrl;
  const cachedUrl = cache.get(imageUrl);
  if (cachedUrl) {
    console.log(`Кэшированное изображение для ${imageUrl}: ${cachedUrl}`);
    return cachedUrl;
  }
  try {
    console.log(`Улучшение изображения: ${imageUrl}`);
    const imageResponse = await axios.get(imageUrl.replace('t_thumb', 't_1080p'), { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const outputDir = path.join(__dirname, 'images');
    await fs.mkdir(outputDir, { recursive: true });
    const outputFilename = `enhanced_${path.basename(imageUrl)}`;
    const outputPath = path.join(outputDir, outputFilename);
    await sharp(imageBuffer)
      .resize({ width: 1000, height: 1500, fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .sharpen({ sigma: 2.5 })
      .gamma(2.0)
      .toFormat('jpeg', { quality: 95 })
      .toFile(outputPath);
    const enhancedUrl = `/images/${outputFilename}`;
    cache.set(imageUrl, enhancedUrl);
    console.log(`Улучшенное изображение сохранено: ${enhancedUrl}`);
    return enhancedUrl;
  } catch (error) {
    console.error(`Ошибка улучшения изображения: ${error.message}`);
    return imageUrl.replace('t_thumb', 't_cover_big_2x'); // Fallback на t_cover_big_2x
  }
}

// Функция для получения обложки из Steam
async function getSteamCover(gameName, platforms) {
  if (!platforms.includes('Steam')) return null;
  try {
    console.log(`Поиск обложки Steam для ${gameName}`);
    const steamResponse = await axios.get(steamUrl);
    const app = steamResponse.data.applist.apps.find(a => a.name.toLowerCase() === gameName.toLowerCase());
    if (app) {
      const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
      cache.set(gameName, coverUrl);
      console.log(`Найдена обложка Steam: ${coverUrl}`);
      return coverUrl;
    }
    console.log(`Обложка Steam не найдена для ${gameName}`);
    return null;
  } catch (error) {
    console.error(`Ошибка Steam для ${gameName}: ${error.message}`);
    return null;
  }
}

// Функция для получения обложки
async function getGameCover(gameName, platforms, igdbCover) {
  const steamCover = await getSteamCover(gameName, platforms);
  if (steamCover) return steamCover;
  return await enhanceImage(igdbCover);
}

// Функция для обработки краткой информации об игре
async function processShortGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map(p => p.name) : ['N/A'];
  const finalCoverImage = await getGameCover(game.name, platforms, coverImage);
  console.log(`Итоговое изображение для ${game.name}: ${finalCoverImage}`);
  return {
    id: game.id,
    name: game.name,
    cover_image: finalCoverImage,
    critic_rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : 'N/A',
    release_year: game.release_dates && game.release_dates.length > 0 && game.release_dates[game.release_dates.length - 1].date
      ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).getFullYear()
      : 'В разработке',
    main_genre: game.genres && game.genres.length > 0 ? game.genres[0].name : 'N/A',
    platforms: platforms
  };
}

// Функция для обработки полной информации об игре
async function processGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map(p => p.name) : ['N/A'];
  const finalCoverImage = await getGameCover(game.name, platforms, coverImage);
  console.log(`Итоговое изображение для ${game.name}: ${finalCoverImage}`);
  const similarGames = game.similar_games ? await Promise.all(game.similar_games.map(async s => {
    const similarCoverImage = s.cover ? `https:${s.cover.url}` : 'N/A';
    const similarPlatforms = s.platforms ? s.platforms.map(p => p.name) : ['N/A'];
    const finalSimilarCoverImage = await getGameCover(s.name, similarPlatforms, similarCoverImage);
    console.log(`Итоговое изображение для similar ${s.name}: ${finalSimilarCoverImage}`);
    return {
      id: s.id,
      name: s.name,
      cover_image: finalSimilarCoverImage,
      critic_rating: s.aggregated_rating ? Math.round(s.aggregated_rating) : 'N/A',
      release_year: s.release_dates && s.release_dates.length > 0 && s.release_dates[s.release_dates.length - 1].date
        ? new Date(s.release_dates[s.release_dates.length - 1].date * 1000).getFullYear()
        : 'N/A',
      main_genre: s.genres && s.genres.length > 0 ? s.genres[0].name : 'N/A',
      platforms: similarPlatforms
    };
  })) : ['N/A'];

  return {
    id: game.id,
    name: game.name,
    genres: game.genres ? game.genres.map(g => g.name) : ['N/A'],
    platforms: platforms,
    release_date: game.release_dates && game.release_dates.length > 0 && game.release_dates[game.release_dates.length - 1].date
      ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).toISOString().split('T')[0]
      : 'N/A',
    rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : (game.rating ? Math.round(game.rating) : 'N/A'),
    rating_type: game.aggregated_rating ? 'Критики' : (game.rating ? 'Пользователи' : 'N/A'),
    cover_image: finalCoverImage,
    age_ratings: game.age_ratings ? game.age_ratings.map(r => {
      const ratings = {
        1: 'ESRB: EC', 2: 'ESRB: E', 3: 'ESRB: E10+', 4: 'ESRB: T', 5: 'ESRB: M', 6: 'ESRB: AO',
        7: 'PEGI: 3', 8: 'PEGI: 7', 9: 'PEGI: 12', 10: 'PEGI: 16', 11: 'PEGI: 18'
      };
      return ratings[r.rating] || 'N/A';
    }) : ['N/A'],
    summary: game.summary || 'N/A',
    developers: game.involved_companies ? game.involved_companies.map(c => c.company.name) : ['N/A'],
    videos: game.videos ? game.videos.map(v => `https://www.youtube.com/watch?v=${v.video_id}`) : ['N/A'],
    similar_games: similarGames
  };
}

// Эндпоинт для списка популярных игр (с сортировкой по рейтингу)
app.get('/popular', async (req, res) => {
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; limit 10; sort aggregated_rating desc;';
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    const data = response.data;
    const games = await Promise.all(data.map(processShortGame));
    res.json(games);
  } catch (error) {
    console.error(`Ошибка /popular: ${error.message}`);
    res.status(500).json({ error: 'Ошибка при получении данных: ' + (error.response ? error.response.status : error.message) });
  }
});

// Эндпоинт для хаотичного списка игр
app.get('/games', async (req, res) => {
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; limit 5;';
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    const data = response.data;
    const shuffledData = shuffle([...data]);
    const games = await Promise.all(shuffledData.slice(0, 10).map(processShortGame));
    res.json(games);
  } catch (error) {
    console.error(`Ошибка /games: ${error.message}`);
    res.status(500).json({ error: 'Ошибка при получении данных: ' + (error.response ? error.response.status : error.message) });
  }
});

// Эндпоинт для полной информации об игре по ID
app.get('/games/:id', async (req, res) => {
  try {
    const gameId = req.params.id;
    const body = `fields id, name, genres.name, platforms.name, release_dates.date, aggregated_rating, rating, cover.url, age_ratings.rating, summary, involved_companies.company.name, videos.video_id, similar_games.id, similar_games.name, similar_games.cover.url, similar_games.aggregated_rating, similar_games.release_dates.date, similar_games.genres.name, similar_games.platforms.name; where id = ${gameId};`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    const data = response.data;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Игра не найдена' });
    }

    const game = await processGame(data[0]);
    res.json(game);
  } catch (error) {
    console.error(`Ошибка /games/:id: ${error.message}`);
    res.status(500).json({ error: 'Ошибка при получении данных: ' + (error.response ? error.response.status : error.message) });
  }
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});
