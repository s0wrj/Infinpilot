// js/ragManager.js

import { getEmbedding, rerank } from './utils/siliconflowAPI.js';
import vectorDB from './vectorDB.js';

/**
 * Augments a user query with context from a vector database and returns both the augmented prompt and citations.
 * @param {string} query - The original user query.
 * @param {number} dbId - The ID of the database to search in.
 * @returns {Promise<{prompt: string, citations: Array<{ id: number|null, text: string, source?: string, score?: number }>}>}
 */
export async function augmentQuery(query, dbId) {
    console.log(`Augmenting query for DB: ${dbId}`);
    try {
        await vectorDB.init();

        // Load RAG settings (threshold and strategy)
        let minScore = 0.35;
        let strategy = 'hybrid'; // 'hybrid' | 'kb_only'
        try {
            const stored = await browser.storage.sync.get('ragSettings');
            if (stored && stored.ragSettings) {
                if (typeof stored.ragSettings.minScore === 'number') minScore = stored.ragSettings.minScore;
                if (typeof stored.ragSettings.strategy === 'string') strategy = stored.ragSettings.strategy;
            }
        } catch (e) {
            console.warn('[RAG] Failed to load ragSettings, using defaults.', e);
        }

        // 1. Get embedding for the user's query
        const queryVector = await getEmbedding(query);

        // 2. Query the local vector DB for an initial set of relevant documents
        const initialResults = await vectorDB.query(dbId, queryVector, 20); // Retrieve more results for reranking

        if (!initialResults || initialResults.length === 0) {
            console.log('No relevant documents found in DB. Returning original query.');
            return { prompt: query, citations: [] };
        }

        // 3. Rerank the initial results to improve relevance
        const reranked = await rerank(query, initialResults.map(doc => doc.text));
        // Map back to original docs with ids/sources
        const mapped = reranked.map((r, i) => {
            const byIndex = r.index != null ? initialResults[r.index] : null;
            const fallback = initialResults[i] || {};
            const doc = byIndex || fallback;
            return {
                id: doc.id ?? null,
                text: r.text ?? doc.text,
                source: doc.source,
                score: r.score ?? doc.similarity
            };
        });

        // 4. Gate by relevance score to avoid forcing KB usage when irrelevant
        const BEST_SCORE = mapped[0]?.score ?? null;
        const SIMILARITY_FALLBACK = initialResults[0]?.similarity ?? null;
                const effectiveScore = (BEST_SCORE != null) ? BEST_SCORE : (SIMILARITY_FALLBACK != null ? SIMILARITY_FALLBACK : null);
        if (effectiveScore != null && effectiveScore < minScore) {
            console.log('[RAG] Top score below threshold, skipping KB augmentation. score=', effectiveScore);
            return { prompt: query, citations: [] };
        }

        // 5. Take top 5 results
        const topResults = mapped.slice(0, 5);
        const context = topResults.map((d, idx) => `[#${idx + 1}] ${d.text}`).join('\n\n---\n\n');

        // 6. Construct prompt according to strategy
        let finalPrompt = '';
        if (strategy === 'kb_only') {
            finalPrompt = `Based on the following information (KB excerpts, cite as [#n]):\n---\n${context}\n---\n\nAnswer the question: ${query}`;
        } else {
            // hybrid (default): optional KB, prefer current page
            finalPrompt = `You may optionally use the following knowledge base excerpts if they truly help.\n- PRIORITY: Prefer the current page content provided by the system.\n- If there is any conflict, follow the current page.\n- Only cite KB excerpts when actually used (cite as [#n]).\n\nOptional KB context:\n---\n${context}\n---\n\nUser question: ${query}`;
        }
        
        console.log('Augmented prompt created.');
        return { prompt: finalPrompt, citations: topResults };

    } catch (error) {
        console.error('Error augmenting query:', error);
        // In case of error, fall back to the original query
        return { prompt: query, citations: [] };
    }
}
