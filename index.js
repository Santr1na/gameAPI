const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const NodeCache = require('node-cache');
const app = express();
const port = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 86400 }); // 24-hour cache
const historyCache = new NodeCache({ stdTTL: 604800 }); // 7-day history
const historyKey = 'recent_games';
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'images')));
const clientId = '6suowimw8bemqf3u9gurh7qnpx74sd';
const accessToken = 'q4hi62k3igoelslpmuka0vw2uwz8gv';
const igdbUrl = 'https://api.igdb.com/v4/games';
const steamUrl = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
const igdbHeaders = { 'Client-ID': clientId, 'Authorization': `Bearer ${accessToken}` };

// Weighted shuffle to prioritize less recently shown games
function weightedShuffle(array, history) {
  const weights = array.map(game => {
    const recentCount = history.includes(game.id) ? 0.01 : 1; // Stronger penalty for recent games
    return recentCount * (Math.random() + 1);
  });
  const sorted = array.map((game, i) => ({ game, weight: weights[i] }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ game }) => game);
  return sorted;
}

// Update game history
function updateHistory(gameIds) {
  let history = historyCache.get(historyKey) || [];
  history = [...new Set([...gameIds, ...history])].slice(0, 200); // Increased to 200 unique games
  historyCache.set(historyKey, history);
}

// Enhance image using Sharp
async function enhanceImage(imageUrl) {
  if (!imageUrl || imageUrl === 'N/A') return imageUrl;
  const cached = cache.get(imageUrl);
  if (cached) return cached;
  try {
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
    return enhancedUrl;
  } catch (error) {
    console.error(`Image enhancement error: ${error.message}`);
    return imageUrl.replace('t_thumb', 't_cover_big_2x');
  }
}

// Get Steam cover
async function getSteamCover(gameName, platforms) {
  if (!platforms.includes('Steam')) return null;
  try {
    const steamResponse = await axios.get(steamUrl);
    const app = steamResponse.data.applist.apps.find(a => a.name.toLowerCase() === gameName.toLowerCase());
    if (app) {
      const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
      cache.set(gameName, coverUrl);
      return coverUrl;
    }
    return null;
  } catch (error) {
    console.error(`Steam cover error for ${gameName}: ${error.message}`);
    return null;
  }
}

// Get game cover
async function getGameCover(gameName, platforms, igdbCover) {
  const steamCover = await getSteamCover(gameName, platforms);
  return steamCover || await enhanceImage(igdbCover);
}

// Process short game info
async function processShortGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map(p => p.name) : ['N/A'];
  return {
    id: game.id,
    name: game.name,
    cover_image: await getGameCover(game.name, platforms, coverImage),
    critic_rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : 'N/A',
    release_year: game.release_dates?.length ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).getFullYear() : 'В разработке',
    main_genre: game.genres?.[0]?.name || 'N/A',
    platforms
  };
}

// Process full game info
async function processGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map(p => p.name) : ['N/A'];
  const genres = game.genres ? game.genres.map(g => g.name) : ['N/A'];
  const summary = game.summary || 'N/A';
  const similarGames = game.similar_games ? await Promise.all(game.similar_games.map(async s => {
    const similarCoverImage = s.cover ? `https:${s.cover.url}` : 'N/A';
    const similarPlatforms = s.platforms ? s.platforms.map(p => p.name) : ['N/A'];
    const similarName = s.name;
    const similarMainGenre = s.genres?.[0]?.name || 'N/A';
    return {
      id: s.id,
      name: similarName,
      cover_image: await getGameCover(s.name, similarPlatforms, similarCoverImage),
      critic_rating: s.aggregated_rating ? Math.round(s.aggregated_rating) : 'N/A',
      release_year: s.release_dates?.length ? new Date(s.release_dates[s.release_dates.length - 1].date * 1000).getFullYear() : 'N/A',
      main_genre: similarMainGenre,
      platforms: similarPlatforms
    };
  })) : ['N/A'];
  return {
    id: game.id,
    name: game.name,
    genres,
    platforms,
    release_date: game.release_dates?.length ? new Date(game.release_dates[game.release_dates.length - 1].date * 1000).toISOString().split('T')[0] : 'N/A',
    rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : (game.rating ? Math.round(game.rating) : 'N/A'),
    rating_type: game.aggregated_rating ? 'Critics' : (game.rating ? 'Users' : 'N/A'),
    cover_image: await getGameCover(game.name, platforms, coverImage),
    age_ratings: game.age_ratings ? game.age_ratings.map(r => {
      const ratings = { 1: 'ESRB: EC', 2: 'ESRB: E', 3: 'ESRB: E10+', 4: 'ESRB: T', 5: 'ESRB: M', 6: 'ESRB: AO', 7: 'PEGI: 3', 8: 'PEGI: 7', 9: 'PEGI: 12', 10: 'PEGI: 16', 11: 'PEGI: 18' };
      return ratings[r.rating] || 'N/A';
    }) : ['N/A'],
    summary,
    developers: game.involved_companies ? game.involved_companies.map(c => c.company.name) : ['N/A'],
    videos: game.videos ? game.videos.map(v => `https://www.youtube.com/watch?v=${v.video_id}`) : ['N/A'],
    similar_games: similarGames
  };
}

// Popular games endpoint
app.get('/popular', async (req, res) => {
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; limit 10; sort aggregated_rating desc;';
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    const games = await Promise.all(response.data.map(game => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error(`Error /popular: ${error.message}`);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

// Random games endpoint with improved randomness
app.get('/games', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * 50;
    const history = historyCache.get(historyKey) || [];
    const excludeIds = history.length > 0 ? `where id != (${history.join(',')});` : '';
    const body = `fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; ${excludeIds} limit 10; offset ${offset};`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    const data = response.data;
    if (!data?.length) {
      historyCache.set(historyKey, []);
      return res.status(404).json({ error: 'No new games available' });
    }
    const shuffledData = weightedShuffle(data, history);
    const selectedGames = shuffledData.slice(0, 10);
    updateHistory(selectedGames.map(g => g.id));
    const games = await Promise.all(selectedGames.map(game => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error(`Error /games: ${error.message}`);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

// Game details endpoint
app.get('/games/:id', async (req, res) => {
  try {
    const gameId = req.params.id;
    const body = `fields id, name, genres.name, platforms.name, release_dates.date, aggregated_rating, rating, cover.url, age_ratings.rating, summary, involved_companies.company.name, videos.video_id, similar_games.id, similar_games.name, similar_games.cover.url, similar_games.aggregated_rating, similar_games.release_dates.date, similar_games.genres.name, similar_games.platforms.name; where id = ${gameId};`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders });
    if (!response.data?.length) return res.status(404).json({ error: 'Game not found' });
    const game = await processGame(response.data[0]);
    res.json(game);
  } catch (error) {
    console.error(`Error /games/:id: ${error.message}`);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
