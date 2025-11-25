(async function() {
    'use strict';

    // === STORAGE + USER SETTINGS ===
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

    let omdbBlocked = false;
    let tmdbBlocked = false;

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
            
            if (data.movie_results?.[0]) {
                const movie = data.movie_results[0];
                return { 
                    id: movie.id, 
                    type: 'movie',
                    rating: movie.vote_average ? movie.vote_average.toFixed(1) : null
                };
            }
            
            if (data.tv_results?.[0]) {
                const tv = data.tv_results[0];
                return { 
                    id: tv.id, 
                    type: 'tv',
                    rating: tv.vote_average ? tv.vote_average.toFixed(1) : null
                };
            }
            
            return null;
        } catch (error) {
            console.warn("[WikIMDb] Failed to get TMDb ID via find API:", wikidataId);
            return null;
        }
    }

    // === MOVIE ID DETECTION ===
    async function getMovieIdForPage(page) {
        page = page.split("#")[0]; // strip anchors

        if (isBlacklisted(page)) return null;

        const key = provider === "omdb" ? "tt" : "tmdbId";
        if (cache[page]?.[key]) return cache[page][key];

        // For TMDb, use Wikidata
        if (provider === "tmdb") {
            const wikidataId = await getWikidataItem(page);
            if (wikidataId) {
                const tmdbData = await getTMDbFromWikidata(wikidataId);
                if (tmdbData && tmdbData.rating) {
                    // Cache both the ID data and the rating
                    cache[page] = { tmdbId: tmdbData };
                    const ratingKey = `rating_${tmdbData.type}_${tmdbData.id}`;
                    cache[ratingKey] = tmdbData.rating;
                    saveCache();
                    return tmdbData;
                }
            }
            cache[page] = { tmdbId: null };
            saveCache();
            return null;
        }

        // For OMDb, use external links method
        const url = `https://${wikiLang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=externallinks&redirects=1&format=json&origin=*`;

        let raw;
        try {
            raw = await queuedFetch(url);
        } catch (error) {
            console.warn("[WikIMDb] Wikipedia fetch failed for:", page);
            return null;
        }

        let data;
        try {
            data = JSON.parse(raw);
            if (data.error || !data.parse) return null;
        } catch {
            console.warn("[WikIMDb] Wikipedia returned HTML instead of JSON:", page);
            return null;
        }

        const ex = data.parse?.externallinks || [];

        for (const l of ex) {
            const tt = l.match(/tt\d{5,9}/i)?.[0];
            if (tt) {
                cache[page] = { tt };
                saveCache();
                return tt;
            }
        }

        cache[page] = { tt: null };
        saveCache();
        return null;
    }

    // === OMDb API ===
    async function fetchOMDb(tt) {
        if (omdbBlocked) return null;

        try {
            const raw = await queuedFetch(`https://www.omdbapi.com/?apikey=${omdbKey}&i=${tt}`);
            const data = JSON.parse(raw);
            
            if (data?.Error === "Request limit reached!") {
                console.warn("[WikIMDb] OMDb quota reached");
                omdbBlocked = true;
                return null;
            }
            
            return data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null;
        } catch {
            console.warn("[WikIMDb] OMDb fetch failed");
            return null;
        }
    }

    // === RATING PROVIDER ===
    async function getRating(id) {
        if (provider === "tmdb" && typeof id === 'object' && id.rating) {
            return id.rating;
        }

        if (provider === "omdb") {
            const ratingKey = `rating_${id}`;
            if (cache[ratingKey]) return cache[ratingKey];

            const rating = await fetchOMDb(id);
            cache[ratingKey] = rating || null;
            saveCache();
            return rating;
        }

        return null;
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
        const id = await getMovieIdForPage(currentPage);
        if (id) {
            const rating = await getRating(id);
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
        // Mark all links as processed to avoid reprocessing
        pageLinks.forEach(link => link.dataset.imdbProcessed = "1");

        // Process each page asynchronously without waiting for others
        (async () => {
            try {
                const id = await getMovieIdForPage(page);
                if (!id) return;
                
                const rating = await getRating(id);
                if (!rating) return;
                
                // Apply rating to all links for this page as soon as it's available
                pageLinks.forEach(link => addStar(link, rating));
                
            } catch (error) {
                console.warn("[WikIMDb] Error processing page:", page);
            }
        })();
    });

})();
