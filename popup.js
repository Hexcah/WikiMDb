const storage = globalThis.browser ? browser.storage.local : chrome.storage.local;

document.getElementById("save").onclick = async () => {

    const provider = document.querySelector("input[name='provider']:checked")?.value;

    await storage.set({
        provider: provider || "tmdb",
        omdbKey: document.getElementById("omdbKey").value.trim(),
        tmdbKey: document.getElementById("tmdbKey").value.trim()
    });

    const status = document.getElementById("status");
    status.textContent = "Key Saved";
    status.className = "success";

    setTimeout(() => window.close(), 700);
};

(async () => {
    const cfg = await storage.get(["provider", "omdbKey", "tmdbKey"]);

    if (cfg.provider) {
        document.querySelector(`input[value="${cfg.provider}"]`).checked = true;
    } else {
        document.querySelector(`input[value="tmdb"]`).checked = true; // default recommended
    }

    if (cfg.omdbKey) document.getElementById("omdbKey").value = cfg.omdbKey;
    if (cfg.tmdbKey) document.getElementById("tmdbKey").value = cfg.tmdbKey;
})();
