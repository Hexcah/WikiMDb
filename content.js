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

    try {
        const raw = localStorage.getItem(CACHE_KEY);
        cache = raw ? JSON.parse(raw) : {};
    } catch {
        cache = {};
    }

    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));

    const wikiLang = location.hostname.split(".")[0];
    const links = [...document.querySelectorAll("a[href^='/wiki/']")];
    // console.log("[WikIMDb] Links wiki found :", links.length);

    const imdbRegex = /tt\d{5,9}/i;

    async function getIMDbIdForPage(page) {
        if (cache[page]?.tt) {
            // console.log("[WikIMDb] TT from cache :", page, cache[page].tt);
            return cache[page].tt;
        }

        const url = `https://${wikiLang}.wikipedia.org/w/api.php?action=parse&page=${page}&prop=externallinks&format=json&origin=*`;
        // console.log("[WikIMDb] Fetch externallinks :", url);

        try {
            const r = await fetch(url);
            const data = await r.json();

            if (!data.parse?.externallinks) {
                console.trace("[WikIMDb] No externallinks found for page :", page);
                cache[page] = { tt: null };
                saveCache();
                return null;
            }

            const links = data.parse.externallinks;
            for (const l of links) {
                const tt = l.match(imdbRegex)?.[0];
                if (tt) {
                    // console.log("[WikIMDb] TT detected :", tt, "for page :", page);
                    cache[page] = { tt };
                    saveCache();
                    return tt;
                }
            }

            // console.log("[WikIMDb] No TT found in externallinks for page :", page);
            cache[page] = { tt: null };
            saveCache();
            return null;

        } catch (err) {
            console.warn("[WikIMDb] WARN fetch externallinks :", page, err);
            return null;
        }
    }

    async function getRating(tt) {
        if (cache[tt]?.rating) {
            // console.log("[WikIMDb] Rating from cache :", tt, cache[tt].rating);
            return cache[tt].rating;
        }

        const url = `https://www.omdbapi.com/?apikey=${apiKey}&i=${tt}`;
        // console.log("[WikIMDb] Fetch OMDb :", url);

        try {
            const r = await fetch(url, { referrerPolicy: "no-referrer" });
            const data = await r.json();
            console.trace("[WikIMDb] OMDb response :", tt, data);

            if (!data.imdbRating || data.imdbRating === "N/A") {
                cache[tt] = { rating: null };
                saveCache();
                return null;
            }

            cache[tt] = cache[tt] || {};
            cache[tt].rating = data.imdbRating;
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

        const page = decodeURIComponent(href.replace("/wiki/", ""));
        const tt = await getIMDbIdForPage(page);
        if (!tt) return;

        const rating = await getRating(tt);
        if (!rating) return; // ignore N/A

        addStar(link, rating);
        // console.log("[WikIMDb] ⭐ Rating added :", rating, "to link", link);
    });

})();