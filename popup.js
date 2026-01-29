const storage = globalThis.browser ? browser.storage.local : chrome.storage.local;

document.getElementById("save").onclick = async () => {
    await storage.set({
        tmdbKey: document.getElementById("tmdbKey").value.trim(),
        showMovies: document.getElementById("showMovies").checked,
        showTV: document.getElementById("showTV").checked,
        showSeasons: document.getElementById("showSeasons").checked,
        showEpisodes: document.getElementById("showEpisodes").checked
    });

    const status = document.getElementById("status");
    status.textContent = "Settings Saved";
    status.className = "success";

    setTimeout(() => window.close(), 700);
};

(async () => {
    const cfg = await storage.get(["tmdbKey", "showMovies", "showTV", "showSeasons", "showEpisodes"]);

    if (cfg.tmdbKey) document.getElementById("tmdbKey").value = cfg.tmdbKey;
    
    // Set checkboxes (default: only movies and TV shows)
    document.getElementById("showMovies").checked = cfg.showMovies !== false;
    document.getElementById("showTV").checked = cfg.showTV !== false;
    document.getElementById("showSeasons").checked = cfg.showSeasons === true;
    document.getElementById("showEpisodes").checked = cfg.showEpisodes === true;
})();
