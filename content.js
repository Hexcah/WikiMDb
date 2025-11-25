(async function() {
    'use strict';

    // === STORAGE + USER SETTINGS ===
    const storageApi = globalThis.browser ? globalThis.browser.storage.local : chrome.storage.local;
    const cfg = await storageApi.get([
        "tmdbKey", "showMovies", "showTV", "showSeasons", "showEpisodes", "showPeople"
    ]);

    const tmdbKey = cfg.tmdbKey || "";
    const contentPrefs = {
        movies: cfg.showMovies !== false,
        tv: cfg.showTV !== false,
        seasons: cfg.showSeasons === true,
        episodes: cfg.showEpisodes === true,
        people: cfg.showPeople === true
    };

    if (!tmdbKey) {
        console.warn("[WikIMDb] No TMDb key configured");
        return;
    }

    // === CACHE SYSTEM ===
    const CACHE_KEY = "wikimdb_cache_v_0_7_0";
    let cache = {};

    try {
        const raw = localStorage.getItem(CACHE_KEY);
        cache = raw ? JSON.parse(raw) : {};
    } catch { cache = {}; }

    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));

    // === REQUEST QUEUE (ANTI-FLOOD) ===
    const MAX_PARALLEL = 15;
    let running = 0;
    const queue = [];

    function queuedFetch(url, opts = {}) {
        return new Promise((resolve, reject) => {
            queue.push({ url, opts, resolve, reject });
            runQueue();
        });
    }

    function runQueue() {
        while (running < MAX_PARALLEL && queue.length > 0) {
            const job = queue.shift();
            running++;

            fetch(job.url, job.opts)
                .then(res => {
                    running--;
                    runQueue();
                    return res.text();
                })
                .then(job.resolve)
                .catch(err => {
                    running--;
                    runQueue();
                    job.reject(err);
                });
        }
    }

    // === WIKIPEDIA LINKS DETECTION ===
    const wikiLang = location.hostname.split(".")[0];
    const links = [...document.querySelectorAll("a[href^='/wiki/']")];

    // === BLACKLIST SYSTEM ===
    let blacklistPatterns = [];
    
    // Load blacklist patterns from JSON file
    async function loadBlacklist() {
        try {
            const response = await fetch(chrome.runtime.getURL('blacklist.json'));
            const blacklistData = await response.json();
            blacklistPatterns = blacklistData.patterns.map(pattern => new RegExp(pattern, 'i'));
        } catch (error) {
            console.warn("[WikIMDb] Failed to load blacklist:", error);
        }
    }

    // Check if a page should be skipped based on blacklist
    function isBlacklisted(page) {
        return blacklistPatterns.some(pattern => pattern.test(page));
    }

    // Load blacklist at startup
    await loadBlacklist();

    // === WIKIDATA API ===
    async function getWikidataItem(page) {
        const url = `https://${wikiLang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(page)}&prop=pageprops&redirects=1&format=json&origin=*`;
        
        try {
            const raw = await queuedFetch(url);
            const data = JSON.parse(raw);
            const pages = data.query?.pages;
            const pageData = pages ? Object.values(pages)[0] : null;
            return pageData?.pageprops?.wikibase_item || null;
        } catch (error) {
            console.warn("[WikIMDb] Failed to get Wikidata item for:", page);
            return null;
        }
    }

    async function getTMDbFromWikidata(wikidataId) {
        try {
            const url = `https://api.themoviedb.org/3/find/${wikidataId}?api_key=${tmdbKey}&external_source=wikidata_id`;
            const raw = await queuedFetch(url);
            const data = JSON.parse(raw);
            
            // Check for movies
            if (data.movie_results?.[0] && contentPrefs.movies) {
                const movie = data.movie_results[0];
                return { 
                    id: movie.id, 
                    type: 'movie',
                    rating: movie.vote_average ? movie.vote_average.toFixed(1) : null
                };
            }
            
            // Check for TV shows
            if (data.tv_results?.[0] && contentPrefs.tv) {
                const tv = data.tv_results[0];
                return { 
                    id: tv.id, 
                    type: 'tv',
                    rating: tv.vote_average ? tv.vote_average.toFixed(1) : null
                };
            }

            // Check for TV seasons
            if (data.tv_season_results?.[0] && contentPrefs.seasons) {
                const season = data.tv_season_results[0];
                return { 
                    id: season.id, 
                    type: 'season',
                    rating: season.vote_average ? season.vote_average.toFixed(1) : null
                };
            }

            // Check for TV episodes
            if (data.tv_episode_results?.[0] && contentPrefs.episodes) {
                const episode = data.tv_episode_results[0];
                return { 
                    id: episode.id, 
                    type: 'episode',
                    rating: episode.vote_average ? episode.vote_average.toFixed(1) : null
                };
            }

            // Check for people
            if (data.person_results?.[0] && contentPrefs.people) {
                const person = data.person_results[0];
                return { 
                    id: person.id, 
                    type: 'person',
                    rating: person.popularity ? (person.popularity / 10).toFixed(1) : null
                };
            }
            
            return null;
        } catch (error) {
            console.warn("[WikIMDb] Failed to get TMDb data:", error);
            return null;
        }
    }

    // === CONTENT ID DETECTION ===
    async function getContentIdForPage(page) {
        page = page.split("#")[0];
        if (isBlacklisted(page)) return null;

        if (cache[page]?.tmdbId) return cache[page].tmdbId;

        const wikidataId = await getWikidataItem(page);
        if (!wikidataId) {
            cache[page] = { tmdbId: null };
            saveCache();
            return null;
        }

        const tmdbData = await getTMDbFromWikidata(wikidataId);
        if (tmdbData && tmdbData.rating) {
            cache[page] = { tmdbId: tmdbData };
            const ratingKey = `rating_${tmdbData.type}_${tmdbData.id}`;
            cache[ratingKey] = tmdbData.rating;
            saveCache();
            return tmdbData;
        }

        cache[page] = { tmdbId: null };
        saveCache();
        return null;
    }

    // === RATING PROVIDER ===
    async function getRating(data) {
        return (typeof data === 'object' && data.rating) ? data.rating : null;
    }

    // === UI HELPERS ===
    const createStar = (rating, isTitle = false) => {
        const span = document.createElement("span");
        Object.assign(span.style, {
            marginLeft: isTitle ? "8px" : "4px",
            fontSize: isTitle ? "0.7em" : "0.8em",
            opacity: "0.85",
            color: "#F6C700"
        });
        span.textContent = `${rating}⭐`;
        return span;
    };

    const addStar = (link, rating) => link.appendChild(createStar(rating));
    const addStarToTitle = (element, rating) => element.appendChild(createStar(rating, true));

    // === CURRENT PAGE PROCESSING ===
    const currentPage = decodeURIComponent(location.pathname.replace("/wiki/", "")).split("#")[0];

    // Process current page title FIRST (priority for user experience)
    const processTitleAsync = async () => {
        const titleElement = document.querySelector("h1#firstHeading.firstHeading");
        if (!titleElement || titleElement.dataset.imdbProcessed) return;
        
        titleElement.dataset.imdbProcessed = "1";
        const data = await getContentIdForPage(currentPage);
        if (data) {
            const rating = await getRating(data);
            if (rating) addStarToTitle(titleElement, rating);
        }
    };

    // Start title processing immediately
    processTitleAsync();

    // === LINKS PROCESSING ===
    const linksByPage = new Map();
    links.forEach((link) => {
        const href = link.getAttribute("href");
        if (!href || link.dataset.imdbProcessed) return;
        
        let page = decodeURIComponent(href.replace("/wiki/", "")).split("#")[0];
        
        // Skip links that point to the current page
        if (page === currentPage) return;
        
        // Skip blacklisted pages early
        if (isBlacklisted(page)) return;
        
        if (!linksByPage.has(page)) {
            linksByPage.set(page, []);
        }
        linksByPage.get(page).push(link);
    });

    // Process each unique page asynchronously
    Array.from(linksByPage.entries()).forEach(([page, pageLinks]) => {
        pageLinks.forEach(link => link.dataset.imdbProcessed = "1");

        (async () => {
            try {
                const data = await getContentIdForPage(page);
                if (!data) return;
                
                const rating = await getRating(data);
                if (!rating) return;
                
                pageLinks.forEach(link => addStar(link, rating));
            } catch (error) {
                console.warn("[WikIMDb] Error processing page:", page);
            }
        })();
    });

})();
