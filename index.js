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
    const recentCount = history.includes(game.id) ? 0.01 : 1;
    return recentCount * (Math.random() + 1);
  });
  return array.map((game, i) => ({ game, weight: weights[i] }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ game }) => game);
}

// Update game history
function updateHistory(gameIds) {
  let history = historyCache.get(historyKey) || [];
  history = [...new Set([...gameIds, ...history])].slice(0, 200);
  historyCache.set(historyKey, history);
}

// Enhance image using Sharp (optimized to skip if not needed)
async function enhanceImage(imageUrl) {
  if (!imageUrl || imageUrl === 'N/A') return imageUrl;
  const cached = cache.get(imageUrl);
  if (cached) return cached;
  try {
    const imageResponse = await axios.get(imageUrl.replace('t_thumb', 't_cover_big'), { responseType: 'arraybuffer', timeout: 5000 });
    const imageBuffer = Buffer.from(imageResponse.data);
    const outputDir = path.join(__dirname, 'images');
    await fs.mkdir(outputDir, { recursive: true });
    const outputFilename = `enhanced_${path.basename(imageUrl)}`;
    const outputPath = path.join(outputDir, outputFilename);
    await sharp(imageBuffer)
      .resize({ width: 800, height: 1200, fit: 'inside', kernel: 'lanczos3' }) // Reduced size for speed
      .toFormat('jpeg', { quality: 85 }) // Lower quality for faster processing
      .toFile(outputPath);
    const enhancedUrl = `/images/${outputFilename}`;
    cache.set(imageUrl, enhancedUrl);
    return enhancedUrl;
  } catch (error) {
    console.error(`Image enhancement error: ${error.message}`);
    return imageUrl.replace('t_thumb', 't_cover_big'); // Fallback to larger default
  }
}

// Get Steam cover (with timeout and caching)
async function getSteamCover(gameName, platforms) {
  if (!platforms.includes('Steam')) return null;
  const cacheKey = `steam_${gameName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const steamResponse = await axios.get(steamUrl, { timeout: 5000 });
    const app = steamResponse.data.applist.apps.find(a => a.name.toLowerCase() === gameName.toLowerCase());
    if (app) {
      const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${app.appid}/library_600x900.jpg`;
      cache.set(cacheKey, coverUrl, 86400); // Cache for 24 hours
      return coverUrl;
    }
    return null;
  } catch (error) {
    console.error(`Steam cover error for ${gameName}: ${error.message}`);
    return null;
  }
}

// Get game cover (parallelized and optimized)
async function getGameCover(gameName, platforms, igdbCover) {
  const [steamCover] = await Promise.all([getSteamCover(gameName, platforms)]);
  return steamCover || (igdbCover !== 'N/A' ? enhanceImage(igdbCover) : igdbCover);
}

// Process short game info (minimized fields)
async function processShortGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map(p => p.name) : ['N/A'];
  return {
    id: game.id,
    name: game.name,
    cover_image: await getGameCover(game.name, platforms, coverImage),
    critic_rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : 'N/A',
    release_year: game.release_dates?.[0]?.date ? new Date(game.release_dates[0].date * 1000).getFullYear() : 'N/A',
    main_genre: game.genres?.[0]?.name || 'N/A',
    platforms
  };
}

// Process full game info (optimized similar games)
async function processGame(game) {
  const coverImage = game.cover ? `https:${game.cover.url}` : 'N/A';
  const platforms = game.platforms ? game.platforms.map(p => p.name) : ['N/A'];
  const genres = game.genres ? game.genres.map(g => g.name) : ['N/A'];
  const summary = game.summary || 'N/A';
  const similarGames = game.similar_games?.length ? await Promise.all(game.similar_games.slice(0, 3).map(async s => {
    const similarCoverImage = s.cover ? `https:${s.cover.url}` : 'N/A';
    const similarPlatforms = s.platforms ? s.platforms.map(p => p.name) : ['N/A'];
    return {
      id: s.id,
      name: s.name,
      cover_image: await getGameCover(s.name, similarPlatforms, similarCoverImage),
      critic_rating: s.aggregated_rating ? Math.round(s.aggregated_rating) : 'N/A',
      release_year: s.release_dates?.[0]?.date ? new Date(s.release_dates[0].date * 1000).getFullYear() : 'N/A',
      main_genre: s.genres?.[0]?.name || 'N/A',
      platforms: similarPlatforms
    };
  })) : ['N/A'];
  return {
    id: game.id,
    name: game.name,
    genres,
    platforms,
    release_date: game.release_dates?.[0]?.date ? new Date(game.release_dates[0].date * 1000).toISOString().split('T')[0] : 'N/A',
    rating: game.aggregated_rating ? Math.round(game.aggregated_rating) : (game.rating ? Math.round(game.rating) : 'N/A'),
    rating_type: game.aggregated_rating ? 'Critics' : (game.rating ? 'Users' : 'N/A'),
    cover_image: await getGameCover(game.name, platforms, coverImage),
    age_ratings: game.age_ratings ? game.age_ratings.map(r => {
      const ratings = { 1: 'ESRB: EC', 2: 'ESRB: E', 3: 'ESRB: E10+', 4: 'ESRB: T', 5: 'ESRB: M', 6: 'ESRB: AO', 7: 'PEGI: 3', 8: 'PEGI: 7', 9: 'PEGI: 12', 10: 'PEGI: 16', 11: 'PEGI: 18' };
      return ratings[r.rating] || 'N/A';
    }) : ['N/A'],
    summary,
    developers: game.involved_companies ? game.involved_companies.map(c => c.company.name) : ['N/A'],
    videos: game.videos ? game.videos.map(v => `https://www.youtube.com/watch?v=${v.video_id}`).slice(0, 3) : ['N/A'],
    similar_games: similarGames
  };
}

// Popular games endpoint (optimized query)
app.get('/popular', async (req, res) => {
  try {
    const body = 'fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; where aggregated_rating >= 80 & aggregated_rating_count > 5; limit 10;';
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 5000 });
    const games = await Promise.all(response.data.map(game => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error(`Error /popular: ${error.message}`);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

// Random games endpoint with improved randomness (optimized limit)
app.get('/games', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * 50;
    const history = historyCache.get(historyKey) || [];
    const excludeIds = history.length > 0 ? `where id != (${history.join(',')});` : '';
    const body = `fields id, name, cover.url, aggregated_rating, release_dates.date, genres.name, platforms.name; ${excludeIds} limit 5; offset ${offset};`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 5000 });
    const data = response.data;
    if (!data?.length) {
      historyCache.set(historyKey, []);
      return res.status(404).json({ error: 'No new games available' });
    }
    const shuffledData = weightedShuffle(data, history);
    const selectedGames = shuffledData.slice(0, 5); // Reduced to 5 for faster response
    updateHistory(selectedGames.map(g => g.id));
    const games = await Promise.all(selectedGames.map(game => processShortGame(game)));
    res.json(games);
  } catch (error) {
    console.error(`Error /games: ${error.message}`);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

// Game details endpoint (optimized similar games limit)
app.get('/games/:id', async (req, res) => {
  try {
    const gameId = req.params.id;
    const body = `fields id, name, genres.name, platforms.name, release_dates.date, aggregated_rating, rating, cover.url, age_ratings.rating, summary, involved_companies.company.name, videos.video_id, similar_games.id, similar_games.name, similar_games.cover.url, similar_games.aggregated_rating, similar_games.release_dates.date, similar_games.genres.name, similar_games.platforms.name; where id = ${gameId}; limit 1;`;
    const response = await axios.post(igdbUrl, body, { headers: igdbHeaders, timeout: 5000 });
    if (!response.data?.length) return res.status(404).json({ error: 'Game not found' });
    const game = await processGame(response.data[0]);
    res.json(game);
  } catch (error) {
    console.error(`Error /games/:id: ${error.message}`);
    res.status(500).json({ error: 'Data fetch error: ' + (error.response?.status || error.message) });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
