(async function() {
    'use strict';

    // Read user API key
    const storageApi = globalThis.browser ? globalThis.browser.storage.local : chrome.storage.local;
    const result = await storageApi.get(['omdbApiKey']);
    const apiKey = result.omdbApiKey;

    // If no API key → stop everything
    if (!apiKey || apiKey.trim() === "") {
        console.warn("[WikIMDb] No OMDb API key set. Script aborted.");
        return;
    }

    // Cache setup
    const CACHE_KEY = "wikimd_cache_v1";
    let cache = {};

    let omdbBlocked = false;

    try {
        const raw = localStorage.getItem(CACHE_KEY);
        cache = raw ? JSON.parse(raw) : {};
    } catch {
        cache = {};
    }

    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));

    const MAX_PARALLEL = 10;
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
                .then(res => res.text())
                .then(text => {
                    running--;
                    runQueue();
                    job.resolve(text);
                })
                .catch(err => {
                    running--;
                    runQueue();
                    job.reject(err);
                });
        }
    }

    const wikiLang = location.hostname.split(".")[0];
    const links = [...document.querySelectorAll("a[href^='/wiki/']")];
    console.debug("[WikIMDb] Links wiki found :", links.length);

    const imdbRegex = /tt\d{5,9}/i;

    async function getIMDbIdForPage(page) {
        if (cache[page]?.tt) {
            console.debug("[WikIMDb] TT from cache :", page, cache[page].tt);
            return cache[page].tt;
        }

        const url = `https://${wikiLang}.wikipedia.org/w/api.php?action=parse&page=${page}&prop=externallinks&format=json&origin=*`;
        console.debug("[WikIMDb] Fetch externallinks :", url);

        try {
            const raw = await queuedFetch(url);
            let data;

            try {
                data = JSON.parse(raw);
            } catch (e) {
                console.warn("[IMDb] Invalid JSON (HTML received) for:", page);
                return null;
            }

            if (!data.parse?.externallinks) {
                cache[page] = { tt: null };
                saveCache();
                return null;
            }

            const links = data.parse.externallinks;
            for (const l of links) {
                const tt = l.match(imdbRegex)?.[0];
                if (tt) {
                    console.debug("[WikIMDb] TT detected :", tt, "for page :", page);
                    cache[page] = { tt };
                    saveCache();
                    return tt;
                }
            }

            console.debug("[WikIMDb] No TT found in externallinks for page :", page);
            cache[page] = { tt: null };
            saveCache();
            return null;

        } catch (err) {
            console.warn("[WikIMDb] WARN fetch externallinks :", page, err);
            return null;
        }
    }

    async function getRating(tt) {
        if (omdbBlocked) return null;

        if (cache[tt]?.rating) {
            console.debug("[WikIMDb] Rating from cache :", tt, cache[tt].rating);
            return cache[tt].rating;
        }

        const url = `https://www.omdbapi.com/?apikey=${apiKey}&i=${tt}`;
        console.debug("[WikIMDb] Fetch OMDb :", url);

        try {
            const raw = await queuedFetch(url, { referrerPolicy: "no-referrer" });
            let data;

            try {
                data = JSON.parse(raw);
            } catch {
                console.warn("[IMDb] Invalid JSON from OMDb:", tt);
                return null;
            }

            // Detect rate-limit
            if (data.Response === "False" && data.Error === "Request limit reached!") {
                console.warn("[WikIMDb] OMDb API rate limit reached. Further requests will be skipped.");
                omdbBlocked = true;
                return null;
            }

            if (!data.imdbRating || data.imdbRating === "N/A") {
                cache[tt] = { rating: null };
                saveCache();
                return null;
            }

            cache[tt] = { rating: data.imdbRating };
            saveCache();
            return data.imdbRating;

        } catch (err) {
            console.warn("[WikIMDb] WARN fetch OMDb :", tt, err);
            return null;
        }
    }

    function addStar(link, rating) {
        const span = document.createElement("span");
        span.style.marginLeft = "4px";
        span.style.fontSize = "0.8em";
        span.style.opacity = "0.85";
        span.textContent = `⭐ ${rating}`;
        link.appendChild(span);
    }

    links.forEach(async (link) => {
        const href = link.getAttribute("href");
        if (!href || link.dataset.imdbProcessed) return;
        link.dataset.imdbProcessed = "1";

        let page = decodeURIComponent(href.split("/wiki/")[1]);
        page = page.split("#")[0]; // remove fragment
        const tt = await getIMDbIdForPage(page);
        if (!tt) return;

        const rating = await getRating(tt);
        if (!rating) return; // ignore N/A

        addStar(link, rating);
        console.debug("[WikIMDb] ⭐ Rating added :", rating, "to link", link);
    });

})();