// js/vectorDB.js

/**
 * A client-side vector database manager using IndexedDB.
 */
class VectorDB {
  constructor(dbName = 'InfinPilotVectorDB') {
    this.dbName = dbName;
    this.db = null;
  }

  /**
   * Initializes the database and creates object stores if they don't exist.
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        this.db = event.target.result;
        if (!this.db.objectStoreNames.contains('vector_databases')) {
          this.db.createObjectStore('vector_databases', { keyPath: 'id', autoIncrement: true });
        }
        if (!this.db.objectStoreNames.contains('documents')) {
          const docStore = this.db.createObjectStore('documents', { keyPath: 'id', autoIncrement: true });
          docStore.createIndex('dbId_index', 'dbId', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('VectorDB initialized successfully.');
        resolve();
      };

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.errorCode);
        reject(event.target.errorCode);
      };
    });
  }

  /**
   * Creates a new vector database.
   * @param {string} name - The name for the new database.
   * @returns {Promise<number>} The ID of the newly created database.
   */
  async createDB(name) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['vector_databases'], 'readwrite');
      const store = transaction.objectStore('vector_databases');
      const request = store.add({ name: name, createdAt: new Date() });

      request.onsuccess = (event) => {
        resolve(event.target.result); // Returns the new key
      };

      request.onerror = (event) => {
        reject('Error creating new DB: ' + event.target.errorCode);
      };
    });
  }

  /**
   * Deletes a vector database and all its associated documents.
   * @param {number} dbId - The ID of the database to delete.
   * @returns {Promise<void>}
   */
  async deleteDB(dbId) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      // First, delete all documents associated with this dbId
      const docTransaction = this.db.transaction(['documents'], 'readwrite');
      const docStore = docTransaction.objectStore('documents');
      const docIndex = docStore.index('dbId_index');
      const docRequest = docIndex.openCursor(IDBKeyRange.only(dbId));

      docRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      docTransaction.oncomplete = () => {
        // Now, delete the database entry itself
        const dbTransaction = this.db.transaction(['vector_databases'], 'readwrite');
        const dbStore = dbTransaction.objectStore('vector_databases');
        const dbRequest = dbStore.delete(dbId);

        dbRequest.onsuccess = () => {
          resolve();
        };

        dbRequest.onerror = (event) => {
          reject('Error deleting DB: ' + event.target.errorCode);
        };
      };

      docTransaction.onerror = (event) => {
        reject('Error deleting documents for DB: ' + event.target.errorCode);
      };
    });
  }

  /**
   * Retrieves all vector databases.
   * @returns {Promise<Array<object>>} A list of all database objects.
   */
  async getAllDBs() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['vector_databases'], 'readonly');
      const store = transaction.objectStore('vector_databases');
      const request = store.getAll();

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        reject('Error fetching all DBs: ' + event.target.errorCode);
      };
    });
  }

  /**
   * Queries the vector database for the most relevant documents.
   * @param {number} dbId - The ID of the database to query.
   * @param {Array<number>} queryVector - The vector of the user's query.
   * @param {number} topK - The number of top results to return.
   * @returns {Promise<Array<object>>} A list of the top K most similar documents.
   */
  async query(dbId, queryVector, topK = 5) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['documents'], 'readonly');
      const store = transaction.objectStore('documents');
      const index = store.index('dbId_index');
      const request = index.getAll(IDBKeyRange.only(dbId));

      request.onsuccess = (event) => {
        const documents = event.target.result;
        if (!documents || documents.length === 0) {
          return resolve([]);
        }

        // Calculate similarity for each document
        const documentsWithSimilarity = documents.map(doc => ({
          ...doc,
          similarity: this._calculateCosineSimilarity(queryVector, doc.vector)
        }));

        // Sort by similarity in descending order
        documentsWithSimilarity.sort((a, b) => b.similarity - a.similarity);

        // Return the top K results
        resolve(documentsWithSimilarity.slice(0, topK));
      };

      request.onerror = (event) => {
        reject('Error querying documents: ' + event.target.errorCode);
      };
    });
  }

  /**
   * Adds a document to a specific database. This will involve chunking, embedding, and storing.
   * @param {number} dbId - The ID of the database to add the document to.
   * @param {string} text - The text content of the document.
   * @param {string} source - The source of the document (e.g., URL or 'Chat History').
   * @returns {Promise<void>}
   */
  async addDocument(dbId, text, source) {
    if (!this.db) await this.init();

    // More robust chunking strategy
    const MAX_CHUNK_SIZE = 400; // Safe character limit
    const finalChunks = [];

    // 1. Split by paragraphs first
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim() !== '');

    for (const paragraph of paragraphs) {
        if (paragraph.length <= MAX_CHUNK_SIZE) {
            finalChunks.push(paragraph);
        } else {
            // 2. If paragraph is too long, split by sentences
            // This regex handles various sentence endings.
            const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]?/g) || [];
            let currentChunk = '';
            for (const sentence of sentences) {
                if (currentChunk.length + sentence.length > MAX_CHUNK_SIZE) {
                    if (currentChunk) finalChunks.push(currentChunk);
                    currentChunk = sentence;
                } else {
                    currentChunk += sentence;
                }
                // If a single sentence is still too long, split it by force
                while (currentChunk.length > MAX_CHUNK_SIZE) {
                    finalChunks.push(currentChunk.substring(0, MAX_CHUNK_SIZE));
                    currentChunk = currentChunk.substring(MAX_CHUNK_SIZE);
                }
            }
            if (currentChunk) finalChunks.push(currentChunk);
        }
    }
    
    if (finalChunks.length === 0) {
        console.log("No text chunks to add after processing.");
        return;
    }

    const { getEmbedding } = await import('./utils/siliconflowAPI.js');

    for (const chunk of finalChunks) {
        if (chunk.trim() === '') continue;

        const vector = await getEmbedding(chunk);

        const document = {
            dbId: dbId,
            text: chunk,
            vector: vector,
            source: source,
            createdAt: new Date()
        };

        await new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['documents'], 'readwrite');
            const store = transaction.objectStore('documents');
            const request = store.add(document);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject('Error adding document: ' + event.target.errorCode);
        });
    }
    console.log(`Successfully added ${finalChunks.length} chunks to the database.`);
  }

  /**
   * Calculates the cosine similarity between two vectors.
   * @param {Array<number>} vecA 
   * @param {Array<number>} vecB 
   * @returns {number} The cosine similarity score.
   */
  _calculateCosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
        return 0;
    }
    const dotProduct = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
    const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
    const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));

    if (magA === 0 || magB === 0) {
        return 0;
    }

    return dotProduct / (magA * magB);
  }
}

// Export a singleton instance
const vectorDB = new VectorDB();
export default vectorDB;
