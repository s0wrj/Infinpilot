/**
 * Retrieves the SiliconFlow API key from storage.
 * @returns {Promise<string>} The API key.
 * @throws {Error} If the API key is not found.
 */
async function getApiKey() {
    return new Promise((resolve, reject) => {
        // Reads from the unified providerSettings object
        browser.storage.sync.get(['providerSettings'], (result) => {
            const apiKey = result.providerSettings?.siliconflow?.apiKey;
            if (apiKey) {
                resolve(apiKey);
            } else {
                reject(new Error('SiliconFlow API key is not set. Please configure it in the settings.'));
            }
        });
    });
}

/**
 * Fetches an embedding for the given text from the SiliconFlow API.
 *
 * @param {string} text The text to embed.
 * @returns {Promise<Array<number>>} A promise that resolves to the embedding vector.
 */
async function getEmbedding(text) {
  const apiKey = await getApiKey();
  const response = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'BAAI/bge-large-zh-v1.5',
      input: Array.isArray(text) ? text : [text]
    })
  });

  if (!response.ok) {
    let errorMessage = 'Unknown error';
    try {
        const errorData = await response.json();
        errorMessage = errorData.error?.message || errorData.message || errorData.msg || JSON.stringify(errorData);
    } catch (e) {
        errorMessage = await response.text();
    }
    throw new Error(`SiliconFlow API error (Embeddings): ${errorMessage}`);
  }

  const data = await response.json();
  // The API returns an array of embeddings. For a single string input, we take the first.
  return data.data[0].embedding;
}

/**
 * Reranks a list of documents based on a query using the SiliconFlow API.
 *
 * @param {string} query The original user query.
 * @param {Array<string>} documents The list of document texts to rerank.
 * @returns {Promise<Array<object>>} A promise that resolves to the reranked list of documents.
 */
async function rerank(query, documents) {
  const apiKey = await getApiKey();
  const response = await fetch('https://api.siliconflow.cn/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'BAAI/bge-reranker-v2-m3',
      query: query,
      documents: documents,
      top_n: 5 // Request top 5 from the API
    })
  });

  if (!response.ok) {
    let errorMessage = 'Unknown error';
    try {
        const errorData = await response.json();
        errorMessage = errorData.error?.message || errorData.message || errorData.msg || JSON.stringify(errorData);
    } catch (e) {
        errorMessage = await response.text();
    }
    throw new Error(`SiliconFlow API error (Rerank): ${errorMessage}`);
  }

  const data = await response.json();
  // Return structured results to preserve index and score for mapping
  return (data.results || []).map(r => ({
    index: r.index,
    score: r.relevance_score ?? r.score ?? null,
    text: documents[r.index]
  }));
}

export { getEmbedding, rerank };
