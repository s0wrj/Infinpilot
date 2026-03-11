(function() {
    'use strict';

    /**
     * A simple extractive summarizer.
     * @param {string} text - The input text.
     * @param {number} sentenceCount - The number of sentences to extract.
     * @returns {string} The summarized text.
     */
    function summarizeText(text, sentenceCount = 3) {
        if (!text) return '';
        // A simple regex to split sentences, not perfect but good for an MVP.
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        return sentences.slice(0, sentenceCount).join(' ').trim();
    }

    /**
     * Extracts all numbers from a text.
     * @param {string} text - The input text.
     * @returns {number[]} An array of numbers found in the text.
     */
    function extractNumbers(text) {
        if (!text) return [];
        const numbers = text.match(/\d+(\.\d+)?/g) || [];
        return numbers.map(Number);
    }

    /**
     * A placeholder for more complex data transformations.
     * @param {string} data - Input data (e.g., JSON string).
     * @returns {object} The transformed data.
     */
    function transformData(data) {
        // In a real scenario, this could parse and restructure JSON, etc.
        try {
            const parsed = JSON.parse(data);
            // Example transformation: add a "processed" timestamp.
            parsed._processed = Date.now();
            return parsed;
        } catch (e) {
            return { error: "Invalid JSON for transformation", original: data };
        }
    }

    // Expose the compute tools to the global DeepResearch namespace
    window.DeepResearch = window.DeepResearch || {};
    window.DeepResearch.tools = window.DeepResearch.tools || {};
    window.DeepResearch.tools.compute = {
        summarizeText,
        extractNumbers,
        transformData,
    };

})();
