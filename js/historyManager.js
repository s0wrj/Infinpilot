// js/historyManager.js

const HISTORY_KEY = 'infinpilot_chat_history';

/**
 * Gets all chat history.
 * @returns {Promise<Array>} A promise that resolves with the chat history array.
 */
async function getHistory() {
    try {
        const result = await chrome.storage.local.get([HISTORY_KEY]);
        return result[HISTORY_KEY] || [];
    } catch (error) {
        console.error("Error getting history:", error);
        return [];
    }
}

/**
 * Saves the entire history array.
 * @param {Array} history - The entire history array to save.
 * @returns {Promise<void>}
 */
async function saveHistory(history) {
    try {
        await chrome.storage.local.set({ [HISTORY_KEY]: history });
    } catch (error) {
        console.error("Error saving history:", error);
    }
}

/**
 * Deletes a chat session by its ID.
 * @param {string} sessionId - The ID of the session to delete.
 * @returns {Promise<void>}
 */
async function deleteHistory(sessionId) {
    let history = await getHistory();
    history = history.filter(s => s.id !== sessionId);
    await saveHistory(history);
}

/**
 * Gets a single chat session by its ID.
 * @param {string} sessionId - The ID of the session to retrieve.
 * @returns {Promise<object|null>} A promise that resolves with the session object or null if not found.
 */
async function getSession(sessionId) {
    const history = await getHistory();
    return history.find(s => s.id === sessionId) || null;
}

/**
 * Adds or updates a chat session.
 * @param {object} session - The chat session object.
 * @returns {Promise<object>} The saved session with an ID.
 */
async function upsertSession(session) {
    const history = await getHistory();
    const existingIndex = history.findIndex(s => s.id === session.id);

    if (existingIndex > -1) {
        // Remove the old session from its current position
        history.splice(existingIndex, 1);
    }

    if (!session.id) {
        session.id = `session_${Date.now()}`;
    }
    
    // Add the new or updated session to the top
    history.unshift(session);

    await saveHistory(history);
    return session;
}

// Exporting functions for use in other modules.
// Since this is not a module, we attach it to the window object for now.
// This will be refactored to use ES modules if the project structure allows.
window.historyManager = {
    getHistory,
    saveHistory,
    deleteHistory,
    getSession,
    upsertSession
};