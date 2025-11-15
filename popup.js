// popup.js

// Universal storage API selector for Chrome/Firefox/Edge (WebExtensions compatibility)
const storageApi = globalThis.browser ? globalThis.browser.storage.local : chrome.storage.local;

document.addEventListener('DOMContentLoaded', () => {
    const keyInput = document.getElementById('omdbKey');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');

    // Load existing key when the popup opens
    storageApi.get(['omdbApiKey']).then((result) => {
        if (result.omdbApiKey) {
            keyInput.value = result.omdbApiKey;
            statusDiv.textContent = 'Current OMDb Key loaded.';
        } else {
            statusDiv.textContent = 'No key found. Please enter your OMDb API key.';
        }
    }).catch(error => {
        console.error("Error loading API key:", error);
        statusDiv.textContent = 'Error loading settings.';
    });

    // Event listener for the "Save" button
    saveButton.addEventListener('click', () => {
        const apiKey = keyInput.value.trim();
        
        if (apiKey.length > 5) {
            // Save the key to the universal storage API
            storageApi.set({ omdbApiKey: apiKey }).then(() => {
                statusDiv.className = 'success';
                statusDiv.textContent = '✅ API Key saved successfully! Reload Wikipedia pages to apply.';
            }).catch(error => {
                 console.error("Error saving API key:", error);
                 statusDiv.textContent = 'Error saving key.';
            });
        } else {
            statusDiv.className = '';
            statusDiv.textContent = 'Please enter a valid API key (must be longer than 5 characters).';
        }
    });
});