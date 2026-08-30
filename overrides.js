/* Mapper-backed episode metadata and the dedicated Ryuu watch page. */
function cleanDescription(value = '') {
  const text = String(value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');
  const decode = document.createElement('textarea');
  decode.innerHTML = text;
  return decode.value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function trimText(value, length) {
  const clean = cleanDescription(value);
  return clean.slice(0, length) + (clean.length > length ? '…' : '');
}

function mapperEndpoint(anilistId) {
  const base = CONFIG.episodeMapper?.baseUrl || 'https://api.ani.zip/';
  const url = new URL('mappings', base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('anilist_id', anilistId);
  return url.toString();
}

async function fetchMappedEpisodes(anime) {
  try {
    const response = await fetch(mapperEndpoint(anime.id), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Mapper returned ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn('Episode mapping unavailable:', error);
    return null;
  }
}

function releasedEpisodeLimit(anime, mapped) {
  const mapperNumbers = Object.values(mapped?.episodes || {}).map(episode => Number(episode?.episode)).filter(Number.isFinite);
  const streamingNumbers = (anime.streamingEpisodes || []).map((episode, index) => Number((episode.title || '').match(/\d+(?:\.\d+)?/)?.[0]) || index + 1);
  const known = Math.max(0, ...mapperNumbers, ...streamingNumbers);
  const nextEpisode = Number(anime.nextAiringEpisode?.episode);
  if (anime.status === 'RELEASING') {
    if (Number.isFinite(nextEpisode) && nextEpisode > 0) return Math.max(0, Math.floor(nextEpisode) - 1);
    return known;
  }
  return Math.max(Number(anime.episodes) || 0, known);
}

async function episodeEntries(anime) {
  const mapping = await fetchMappedEpisodes(anime);
  const byNumber = new Map();
  Object.values(mapping?.episodes || {}).forEach(raw => {
    const number = Number(raw?.episode);
    if (!Number.isInteger(number) || number < 1) return;
    byNumber.set(number, {
      number,
      title: raw.title?.en || raw.title?.['x-jat'] || raw.title?.jp || `Episode ${number}`,
      overview: cleanDescription(raw.overview || ''),
      thumbnail: raw.image || '',
      airdate: raw.airdate || raw.airDate || '',
      mapped: true
    });
  });
  const total = releasedEpisodeLimit(anime, mapping);
  const fallbackImage = anime.bannerImage || coverOf(anime);
  return Array.from({ length: total }, (_, index) => {
    const number = index + 1;
    const mapped = byNumber.get(number);
    return mapped ? { ...mapped, thumbnail: mapped.thumbnail || fallbackImage } : {
      number, title: `Episode ${number}`, overview: '', thumbnail: fallbackImage, airdate: '', mapped: false
    };
  });
}

async function openAnime(id) {
  state.returnRoute = state.route === 'detail' || state.route === 'watch' ? state.returnRoute : state.route;
  showRoute('detail');
  document.getElementById('detail-content').innerHTML = '<div class="loading-block">Loading anime details…</div>';
  const query = `query Detail($id: Int) { Media(id: $id, type: ANIME) { id idMal title { romaji english native userPreferred } coverImage { extraLarge large medium color } bannerImage description(asHtml: false) episodes duration format status season seasonYear averageScore popularity genres source countryOfOrigin synonyms startDate { year month day } endDate { year month day } trailer { id site thumbnail } nextAiringEpisode { episode airingAt } streamingEpisodes { title thumbnail url site } mediaListEntry { id status progress score(format: POINT_10) } studios(isMain: true) { nodes { name } } relations { edges { relationType(version: 2) node { id type format status episodes seasonYear title { userPreferred } coverImage { medium } } } } } }`;
  try {
    state.currentAnime = (await anilist(query, { id })).Media;
    state.currentEpisode = 1;
    state.language = state.settings.defaultLanguage;
    state.source = state.settings.preferredSource;
    state.currentAnime.episodeEntries = await episodeEntries(state.currentAnime);
    renderDetail();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    document.getElementById('detail-content').innerHTML = `<div class="empty-state">Could not load this anime. ${escapeHTML(error.message)}</div>`;
  }
}

function formatEpisodeAirdate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function episodeRow(entry) {
  const date = entry.airdate ? `<time class="episode-row-date" datetime="${escapeAttribute(entry.airdate)}">${escapeHTML(formatEpisodeAirdate(entry.airdate))}</time>` : '<span class="episode-row-date">Available</span>';
  return `<img class="episode-row-image" src="${escapeAttribute(entry.thumbnail)}" alt="" loading="lazy"><span class="episode-row-copy"><span class="episode-row-title"><span class="episode-row-number">${entry.number}.</span><span class="episode-row-name">${escapeHTML(entry.title)}</span></span>${entry.overview ? `<span class="episode-row-overview">${escapeHTML(entry.overview)}</span>` : ''}</span>${date}`;
}

function titleEpisodeRow(entry, progress) {
  return `<button class="episode-row ${entry.mapped ? '' : 'is-fallback'} ${entry.number <= progress ? 'is-watched' : ''}" type="button" data-watch-episode="${entry.number}" data-search="${escapeAttribute(`${entry.number} ${entry.title} ${entry.overview}`.toLowerCase())}" title="Watch episode ${entry.number}">${episodeRow(entry)}</button>`;
}

function watchEpisodeRow(entry) {
  return `<button class="episode-row ${entry.mapped ? '' : 'is-fallback'} ${entry.number === state.currentEpisode ? 'is-active' : ''}" type="button" data-play-episode="${entry.number}" data-search="${escapeAttribute(`${entry.number} ${entry.title} ${entry.overview}`.toLowerCase())}" title="Play episode ${entry.number}">${episodeRow(entry)}</button>`;
}

function renderEpisodeToolbar(entries) {
  const note = entries.some(entry => entry.mapped) ? 'Episode names, artwork, and summaries are from the episode mapper.' : 'Episode metadata is unavailable — showing numbered episode fallbacks.';
  return `<div class="episode-list-toolbar"><p>${note}</p><input class="episode-filter" type="search" placeholder="Filter episodes" aria-label="Filter episodes"></div>`;
}

function bindEpisodeFilter(scope) {
  scope.querySelector('.episode-filter')?.addEventListener('input', event => {
    const term = event.target.value.trim().toLowerCase();
    scope.querySelectorAll('[data-search]').forEach(row => { row.hidden = Boolean(term) && !row.dataset.search.includes(term); });
  });
}

function renderDetail() {
  const anime = state.currentAnime, title = titleOf(anime), total = Number(anime.episodes) || '?', entries = anime.episodeEntries || [];
  const year = anime.startDate?.year || anime.seasonYear || '—', banner = anime.bannerImage || coverOf(anime), studios = (anime.studios?.nodes || []).map(studio => studio.name).join(', ');
  const progress = anime.mediaListEntry?.progress || 0, description = cleanDescription(anime.description) || 'No synopsis is available for this title.';
  document.getElementById('detail-content').innerHTML = `<div class="detail-hero"><img class="detail-banner-glow" src="${escapeAttribute(banner)}" alt=""><div class="detail-banner">${anime.bannerImage ? `<img src="${escapeAttribute(anime.bannerImage)}" alt="">` : ''}</div></div><div class="detail-layout"><img class="detail-poster" src="${escapeAttribute(coverOf(anime))}" alt="${escapeAttribute(title)}"><div class="detail-body"><p class="detail-romaji">${escapeHTML(anime.title.romaji || title)}</p><h1>${escapeHTML(anime.title.english || title)}</h1><p class="detail-subtitle">${escapeHTML(anime.title.native || '')}</p><div class="metadata"><span>${escapeHTML(anime.format || 'ANIME')}</span><span>${total} episodes</span>${anime.duration ? `<span>${anime.duration} min</span>` : ''}<span>${escapeHTML(anime.status || 'UNKNOWN')}</span><span>${year}</span>${anime.averageScore ? `<span>★ ${anime.averageScore}/100</span>` : ''}<span>${Number(anime.popularity || 0).toLocaleString()} users</span></div>${state.auth.viewer ? `<div class="anilist-progress"><span>AniList progress</span><strong>${progress} / ${total}</strong></div>` : ''}${studios ? `<p class="detail-fact"><b>Studio</b> ${escapeHTML(studios)}</p>` : ''}${anime.source ? `<p class="detail-fact"><b>Source</b> ${escapeHTML(anime.source.replace(/_/g, ' '))}${anime.countryOfOrigin ? ` · ${escapeHTML(anime.countryOfOrigin)}` : ''}</p>` : ''}<div class="genre-list">${(anime.genres || []).map(genre => `<span class="genre">${escapeHTML(genre)}</span>`).join('')}</div><div class="description">${escapeHTML(description)}</div><div class="external-links"><a href="https://anilist.co/anime/${anime.id}" target="_blank" rel="noreferrer">AniList ↗</a>${anime.idMal ? `<a href="https://myanimelist.net/anime/${anime.idMal}" target="_blank" rel="noreferrer">MyAnimeList ↗</a>` : ''}${anime.trailer?.site === 'youtube' ? `<a href="https://www.youtube.com/watch?v=${anime.trailer.id}" target="_blank" rel="noreferrer">Trailer ↗</a>` : ''}</div></div></div><section class="episode-list-section"><div class="episode-list-header"><div><h2>Episodes</h2><p>${entries.length ? `${entries.length} released episode${entries.length === 1 ? '' : 's'} available to watch.` : 'No episodes are available yet.'}</p></div><button id="watch-first" class="button button-primary" type="button" ${entries.length ? '' : 'disabled'}>Watch now <span>→</span></button></div>${renderEpisodeToolbar(entries)}<div class="episode-list">${entries.map(entry => titleEpisodeRow(entry, progress)).join('') || '<div class="empty-state">AniList has not released an episode for this title yet.</div>'}</div></section>${relationsMarkup(anime)}`;
  const section = document.querySelector('.episode-list-section');
  bindEpisodeFilter(section);
  section.querySelectorAll('[data-watch-episode]').forEach(button => button.addEventListener('click', () => openWatchPage(Number(button.dataset.watchEpisode))));
  section.querySelector('#watch-first')?.addEventListener('click', () => openWatchPage(entries[0]?.number || 1));
}

function playerOptions(anime) {
  return Object.entries(PLAYER_SOURCES).map(([key, source]) => `<option value="${key}" ${key === state.source ? 'selected' : ''} ${source.build(anime, state.currentEpisode, state.language, state.settings.autoplay) ? '' : 'disabled'}>${source.label}${source.build(anime, state.currentEpisode, state.language, state.settings.autoplay) ? '' : ' (unavailable)'}</option>`).join('');
}

function playerMarkup() {
  const anime = state.currentAnime, url = PLAYER_SOURCES[state.source].build(anime, state.currentEpisode, state.language, state.settings.autoplay);
  if (!url) return '<div class="player-card is-active"><div class="player-toolbar"><strong>Playback unavailable</strong><span>This source needs a MyAnimeList ID.</span></div></div>';
  return `<div class="player-card is-active"><div class="player-toolbar"><strong>${escapeHTML(titleOf(anime))} · Episode ${state.currentEpisode}</strong><span>${PLAYER_SOURCES[state.source].label} · ${state.language.toUpperCase()}</span>${state.auth.viewer ? '<button id="mark-watched" class="mark-watched" type="button">Mark watched</button>' : ''}</div><iframe class="player-frame" src="${escapeAttribute(url)}" title="${escapeAttribute(titleOf(anime))} episode ${state.currentEpisode}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
}

function openWatchPage(episode = state.currentEpisode) {
  if (!state.currentAnime) return;
  state.currentEpisode = episode;
  showRoute('watch');
  renderWatchPage();
}

function renderWatchPage() {
  const anime = state.currentAnime;
  if (!anime) return;
  const entries = anime.episodeEntries || [], progress = anime.mediaListEntry?.progress || 0;
  document.getElementById('watch-content').innerHTML = `<section class="watch-page">${playerMarkup()}<div class="watch-header"><h2>${escapeHTML(titleOf(anime))}</h2><div class="watch-controls"><div class="language-toggle"><button class="${state.language === 'sub' ? 'is-active' : ''}" type="button" data-language="sub">Sub</button><button class="${state.language === 'dub' ? 'is-active' : ''}" type="button" data-language="dub">Dub</button></div><select id="source-select" class="source-select" aria-label="Playback source">${playerOptions(anime)}</select></div></div>${renderEpisodeToolbar(entries)}<div class="episode-list">${entries.map(watchEpisodeRow).join('')}</div><p class="player-note">Choose any released episode to switch playback source.</p></section>`;
  const page = document.querySelector('.watch-page');
  bindEpisodeFilter(page);
  page.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => { state.language = button.dataset.language; renderWatchPage(); }));
  page.querySelector('#source-select')?.addEventListener('change', event => { state.source = event.target.value; renderWatchPage(); });
  page.querySelectorAll('[data-play-episode]').forEach(button => button.addEventListener('click', () => playEpisode(Number(button.dataset.playEpisode))));
  page.querySelector('#mark-watched')?.addEventListener('click', () => markEpisodeWatched(state.currentEpisode));
  page.querySelectorAll('[data-play-episode]').forEach(button => button.classList.toggle('is-watched', Number(button.dataset.playEpisode) <= progress));
}

function playEpisode(episode) {
  state.currentEpisode = episode;
  if (state.route !== 'watch') { openWatchPage(episode); return; }
  renderWatchPage();
  document.querySelector('.player-card')?.scrollIntoView({ behavior: state.settings.reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

async function markEpisodeWatched(episode) {
  if (!state.auth.token) return;
  const button = document.getElementById('mark-watched');
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  try {
    const data = await anilist(`mutation SaveProgress($mediaId: Int, $progress: Int) { SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: CURRENT) { id progress status } }`, { mediaId: state.currentAnime.id, progress: episode });
    state.currentAnime.mediaListEntry = data.SaveMediaListEntry;
    toast(`AniList updated to episode ${episode}.`);
    renderWatchPage();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = 'Mark watched'; }
    toast(`Could not update AniList: ${error.message}`, true);
  }
}

function showRoute(route) {
  hideHoverCard();
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('is-active', view.id === `${route}-view`));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('is-active', item.dataset.route === route));
  state.route = route;
  if (route === 'browse' && !state.browse.length) loadBrowse(true);
  window.scrollTo({ top: 0, behavior: state.settings.reducedMotion ? 'auto' : 'smooth' });
}
