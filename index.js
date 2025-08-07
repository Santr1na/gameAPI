const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const clientId = '6suowimw8bemqf3u9gurh7qnpx74sd';
const accessToken = 'q4hi62k3igoelslpmuka0vw2uwz8gv';
const igdbUrl = 'https://api.igdb.com/v4/games';
const deepImageUrl = 'https://deep-image.ai/rest_api/process_result';
const deepImageApiKey = '8e2d5b10-73b4-11f0-bf3f-4f562e7a2c44';

const igdbHeaders = {
  'Client-ID': clientId,
  'Authorization': `Bearer ${accessToken}`,
};

const deepImageHeaders = {
  'x-api-key': deepImageApiKey,
  'Content-Type': 'application/json',
};

// Функция для улучшения изображения через Deep-Image.ai
async function enhanceImage(imageUrl) {
  if (!imageUrl || imageUrl === 'N/A') return imageUrl;
  try {
    console.log(`Отправка изображения на улучшение: ${imageUrl}`);
    const response = await axios.post(deepImageUrl, {
      enhancements: ['denoise', 'deblur', 'light'],
      url: imageUrl,
      width: 2000
    }, { headers: deepImageHeaders });
    const enhancedUrl = response.data.url || imageUrl;
    console.log(`Улучшенный URL: ${enhancedUrl}`);
    return enhancedUrl;
  } catch (error) {
    console.error(`Ошибка улучшения изображения: ${error.message}, Код: ${error.response?.status}`);
    return imageUrl; // Fallback на оригинальный URL
  }
}

// Функция для обработки краткой информации об игре
async function processShortGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const enhancedCoverImage = await enhanceImage(coverImage);
  return {
    id: game.id,
    name: game.name,
    cover_image: enhancedCoverImage,
    critic_rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : 'N/A',
    release_year: game.release_dates && game.release_dates.length > 0 && game.release_dates[game.release_dates.length - 1].date 
      ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).getFullYear() 
      : 'N/A',
    main_genre: game.genres && game.genres.length > 0 ? game.genres[0].name : 'N/A',
    platforms: game.platforms ? game.platforms.map(p => p.name) : ['N/A']
  };
}

// Функция для обработки полной информации об игре
async function processGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const enhancedCoverImage = await enhanceImage(coverImage);
  const similarGames = game.similar_games ? await Promise.all(game.similar_games.map(async s => {
    const similarCoverImage = s.cover ? `https:${s.cover.url}` : 'N/A';
    const enhancedSimilarCoverImage = await enhanceImage(similarCoverImage);
    return {
      id: s.id,
      name: s.name,
      cover_image: enhancedSimilarCoverImage,
      critic_rating: s.aggregated_rating ? Math.round(s.aggregated_rating) : 'N/A',
      release_year: s.release_dates && s.release_dates.length > 0 && s.release_dates[s.release_dates.length - 1].date 
        ? new Date(s.release_dates[s.release_dates.length - 1].date * 1000).getFullYear() 
        : 'N/A',
      main_genre: s.genres && s.genres.length > 0 ? s.genres[0].name : 'N/A',
      platforms: s.platforms ? s.platforms.map(p => p.name) : ['N/A']
    };
  })) : ['N/A'];

  return {
    id: game.id,
    name: game.name,
    genres: game.genres ? game.genres.map(g => g.name) : ['N/A'],
    platforms: game.platforms ? game.platforms.map(p => p.name) : ['N/A'],
    release_date: game.release_dates && game.release_dates.length > 0 && game.release_dates[game.release_dates.length - 1].date 
      ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).toISOString().split('T')[0] 
      : 'N/A',
    rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : (game.rating ? Math.round(game.rating) : 'N/A'),
    rating_type: game.aggregated_rating ? 'Критики' : (game.rating ? 'Пользователи' : 'N/A'),
    cover_image: enhancedCoverImage,
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

// Эндпоинт для списка популярных игр (краткая информация)
app.get('/games', async (req, res) => {
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; limit 10; sort aggregated_rating desc;';
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    const data = response.data;
    const games = await Promise.all(data.map(processShortGame));
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
