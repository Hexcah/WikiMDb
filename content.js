(async function() {
    'use strict';

    // STORAGE + USER SETTINGS
    const storageApi = globalThis.browser ? globalThis.browser.storage.local : chrome.storage.local;
    const cfg = await storageApi.get(["provider", "omdbKey", "tmdbKey"]);

    const provider = cfg.provider || "omdb";
    const omdbKey  = cfg.omdbKey || "";
    const tmdbKey  = cfg.tmdbKey || "";

    if (provider === "omdb" && !omdbKey) {
        console.warn("[WikIMDb] No OMDb key");
        return;
    }

    if (provider === "tmdb" && !tmdbKey) {
        console.warn("[WikIMDb] No TMDb key");
        return;
    }

    // CACHE
    const CACHE_KEY = "wikimdb_cache_v_0_3_0";
    let cache = {};

    try {
        const raw = localStorage.getItem(CACHE_KEY);
        cache = raw ? JSON.parse(raw) : {};
    } catch { cache = {}; }

    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));

    // REQUEST QUEUE (ANTI-FLOOD)
    const MAX_PARALLEL = 5;
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

    // PARSING WIKIPEDIA LINKS
    const wikiLang = location.hostname.split(".")[0];
    const links = [...document.querySelectorAll("a[href^='/wiki/']")];

    let omdbBlocked = false;
    let tmdbBlocked = false;

    const imdbRegex = /tt\d{5,9}/i;
    const tmdbRegex = /themoviedb\.org\/(?:movie|tv)\/(\d+)/i;

    // WIKIPEDIA API
    async function getMovieIdForPage(page) {
        page = page.split("#")[0]; // strip anchors

        const key = provider === "omdb" ? "tt" : "tmdbId";
        if (cache[page]?.[key]) return cache[page][key];

        const url = `https://${wikiLang}.wikipedia.org/w/api.php?action=parse&page=${page}&prop=externallinks&format=json&origin=*`;

        let raw;
        try {
            raw = await queuedFetch(url);
        } catch {
            console.warn("[WikIMDb] Wikipedia fetch failed");
            return null;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            console.warn("[WikIMDb] Wikipedia returned HTML instead of JSON:", page);
            return null;
        }

        const ex = data.parse?.externallinks || [];

        for (const l of ex) {

            // OMDb
            if (provider === "omdb") {
                const tt = l.match(imdbRegex)?.[0];
                if (tt) {
                    cache[page] = { tt };
                    saveCache();
                    return tt;
                }
            }

            // TMDb
            else if (provider === "tmdb") {
                const m = l.match(tmdbRegex);
                if (m) {
                    const tmdbId = m[1];
                    // Detect if it's movie or tv from URL
                    const isTV = l.includes('/tv/');
                    const tmdbData = { id: tmdbId, type: isTV ? 'tv' : 'movie' };
                    cache[page] = { tmdbId: tmdbData };
                    saveCache();
                    return tmdbData;
                }
            }
        }

        cache[page] = provider === "omdb" ? { tt: null } : { tmdbId: null };
        saveCache();
        return null;
    }

    // OMDb
    async function fetchOMDb(tt) {
        if (omdbBlocked) return null;

        const url = `https://www.omdbapi.com/?apikey=${omdbKey}&i=${tt}`;

        let raw;
        try {
            raw = await queuedFetch(url);
        } catch {
            console.warn("[WikIMDb] OMDb fetch failed");
            return null;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            console.warn("[WikIMDb] Invalid JSON from OMDb");
            return null;
        }

        if (data?.Error === "Request limit reached!") {
            console.warn("[WikIMDb] OMDb quota reached");
            omdbBlocked = true;
            return null;
        }

        if (!data.imdbRating || data.imdbRating === "N/A") return null;

        return data.imdbRating;
    }

    // TMDb
    async function fetchTMDb(tmdbData) {
        if (tmdbBlocked) return null;

        // tmdbData should be an object with { id, type }
        const id = typeof tmdbData === 'object' ? tmdbData.id : tmdbData;
        const type = typeof tmdbData === 'object' ? tmdbData.type : 'movie'; // fallback to movie

        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbKey}`;

        let raw;
        try {
            raw = await queuedFetch(url);
        } catch {
            console.warn("[WikIMDb] TMDb fetch failed");
            return null;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            console.warn("[WikIMDb] Invalid JSON from TMDb");
            return null;
        }

        if (data?.status_code === 429) {
            console.warn("[WikIMDb] TMDb rate-limit 429");
            tmdbBlocked = true;
            return null;
        }

        if (data?.status_code === 34) {
            console.warn(`[WikIMDb] TMDb ${type} not found:`, id);
            return null;
        }

        if (!data?.vote_average) return null;

        return data.vote_average.toFixed(1);
    }

    // SELECT PROVIDER
    async function getRating(id) {
        const ratingKey = `rating_${typeof id === 'object' ? `${id.type}_${id.id}` : id}`;
        
        if (cache[ratingKey]) return cache[ratingKey];

        let rating = null;

        if (provider === "omdb") {
            rating = await fetchOMDb(id);
        } else {
            rating = await fetchTMDb(id);
        }

        cache[ratingKey] = rating || null;
        saveCache();
        return rating;
    }

    // UI
    function addStar(link, rating) {
        const span = document.createElement("span");
        span.style.marginLeft = "4px";
        span.style.fontSize = "0.8em";
        span.style.opacity = "0.85";
        span.style.color = "#F6C700";
        span.textContent = `${rating}⭐`;
        link.appendChild(span);
    }

    // Get current page name to exclude it from scoring
    const currentPage = decodeURIComponent(location.pathname.replace("/wiki/", "")).split("#")[0];

    // UI for title
    function addStarToTitle(element, rating) {
        const span = document.createElement("span");
        span.style.marginLeft = "8px";
        span.style.fontSize = "0.7em";
        span.style.opacity = "0.85";
        span.style.color = "#F6C700";
        span.style.fontWeight = "normal";
        span.textContent = `${rating}⭐`;
        element.appendChild(span);
    }

    // ADD RATING TO CURRENT PAGE TITLE
    async function addRatingToCurrentPage() {
        const titleElement = document.querySelector("h1#firstHeading.firstHeading");
        if (!titleElement || titleElement.dataset.imdbProcessed) return;
        
        titleElement.dataset.imdbProcessed = "1";
        
        const id = await getMovieIdForPage(currentPage);
        if (!id) return;

        const rating = await getRating(id);
        if (!rating) return;

        addStarToTitle(titleElement, rating);
    }

    // Execute for current page title
    addRatingToCurrentPage();

    // MAIN LOOP
    const linksByPage = new Map();
    links.forEach((link) => {
        const href = link.getAttribute("href");
        if (!href || link.dataset.imdbProcessed) return;
        
        let page = decodeURIComponent(href.replace("/wiki/", "")).split("#")[0];
        
        // Skip links that point to the current page
        if (page === currentPage) return;
        
        if (!linksByPage.has(page)) {
            linksByPage.set(page, []);
        }
        linksByPage.get(page).push(link);
    });

    // Process each unique page once and apply rating to all its links
    for (const [page, pageLinks] of linksByPage) {
        pageLinks.forEach(link => link.dataset.imdbProcessed = "1");

        const id = await getMovieIdForPage(page);
        if (!id) continue;

        const rating = await getRating(id);
        if (!rating) continue;

        pageLinks.forEach(link => addStar(link, rating));
    }

})();
