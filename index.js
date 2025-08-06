const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const clientId = '6suowimw8bemqf3u9gurh7qnpx74sd';
const accessToken = 'q4hi62k3igoelslpmuka0vw2uwz8gv';
const url = 'https://api.igdb.com/v4/games';
const headers = {
  'Client-ID': clientId,
  'Authorization': `Bearer ${accessToken}`,
};

// Функция для обработки краткой информации об игре
function processShortGame(game) {
  return {
    id: game.id,
    name: game.name,
    cover_image: game.cover ? `https:${game.cover.url}` : 'N/A',
    critic_rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : 'N/A',
    release_year: game.release_dates && game.release_dates.length > 0 && game.release_dates[game.release_dates.length - 1].date 
      ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).getFullYear() 
      : 'N/A',
    main_genre: game.genres && game.genres.length > 0 ? game.genres[0].name : 'N/A',
    platforms: game.platforms ? game.platforms.map(p => p.name) : ['N/A']
  };
}

// Функция для обработки полной информации об игре
function processGame(game) {
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
    cover_image: game.cover ? `https:${game.cover.url}` : 'N/A',
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
    similar_games: game.similar_games ? game.similar_games.map(s => ({
      id: s.id,
      name: s.name,
      cover_image: s.cover ? `https:${s.cover.url}` : 'N/A',
      critic_rating: s.aggregated_rating ? Math.round(s.aggregated_rating) : 'N/A',
      release_year: s.release_dates && s.release_dates.length > 0 && s.release_dates[s.release_dates.length - 1].date 
        ? new Date(s.release_dates[s.release_dates.length - 1].date * 1000).getFullYear() 
        : 'N/A',
      main_genre: s.genres && s.genres.length > 0 ? s.genres[0].name : 'N/A',
      platforms: s.platforms ? s.platforms.map(p => p.name) : ['N/A']
    })) : ['N/A']
  };
}

// Эндпоинт для списка популярных игр (краткая информация)
app.get('/games', async (req, res) => {
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; limit 10; sort aggregated_rating desc;';
    const response = await axios.post(url, body, { headers });
    const data = response.data;
    const games = data.map(processShortGame);
    res.json(games);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении данных: ' + (error.response ? error.response.status : error.message) });
  }
});

// Эндпоинт для полной информации об игре по ID
app.get('/games/:id', async (req, res) => {
  try {
    const gameId = req.params.id;
    const body = `fields id, name, genres.name, platforms.name, release_dates.date, aggregated_rating, rating, cover.url, age_ratings.rating, summary, involved_companies.company.name, videos.video_id, similar_games.id, similar_games.name, similar_games.cover.url, similar_games.aggregated_rating, similar_games.release_dates.date, similar_games.genres.name, similar_games.platforms.name; where id = ${gameId};`;
    const response = await axios.post(url, body, { headers });
    const data = response.data;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Игра не найдена' });
    }

    const game = processGame(data[0]);
    res.json(game);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении данных: ' + (error.response ? error.response.status : error.message) });
  }
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});
