/**
 * BM25 Search — T20: Lightweight text search index (~100 LOC).
 * Parameters: k1=1.2, b=0.75 (standard BM25 tuning).
 */

export class BM25Index {
    constructor(k1 = 1.2, b = 0.75) {
        this.k1 = k1;
        this.b = b;
        this.docs = [];      // [{ id, tokens, length }]
        this.df = new Map();  // term → doc frequency
        this.avgDl = 0;
        this.N = 0;
    }

    /** Tokenize text into lowercase terms. */
    static tokenize(text) {
        return text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
    }

    /** Add a document to the index. */
    addDocument(id, text) {
        const tokens = BM25Index.tokenize(text);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        this.docs.push({ id, tf, length: tokens.length });

        for (const term of tf.keys()) {
            this.df.set(term, (this.df.get(term) || 0) + 1);
        }
        this.N = this.docs.length;
        this.avgDl = this.docs.reduce((s, d) => s + d.length, 0) / this.N;
    }

    /** Build index from array of { id, text } objects. */
    buildIndex(documents) {
        this.docs = [];
        this.df = new Map();
        for (const doc of documents) {
            this.addDocument(doc.id, doc.text);
        }
    }

    /** Search for query, return top-K results sorted by BM25 score. */
    search(query, topK = 10) {
        const queryTokens = BM25Index.tokenize(query);
        if (queryTokens.length === 0) return [];

        const scores = [];

        for (const doc of this.docs) {
            let score = 0;
            for (const qt of queryTokens) {
                const tf = doc.tf.get(qt) || 0;
                if (tf === 0) continue;
                const dfVal = this.df.get(qt) || 0;
                const idf = Math.log((this.N - dfVal + 0.5) / (dfVal + 0.5) + 1);
                const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * doc.length / this.avgDl));
                score += idf * tfNorm;
            }
            if (score > 0) scores.push({ id: doc.id, score });
        }

        return scores.sort((a, b) => b.score - a.score).slice(0, topK);
    }

    /** Serialize index to JSON. */
    toJSON() {
        return {
            k1: this.k1, b: this.b, N: this.N, avgDl: this.avgDl,
            docs: this.docs.map(d => ({ id: d.id, tf: Object.fromEntries(d.tf), length: d.length })),
            df: Object.fromEntries(this.df),
        };
    }

    /** Load index from JSON. */
    static fromJSON(data) {
        const idx = new BM25Index(data.k1, data.b);
        idx.N = data.N;
        idx.avgDl = data.avgDl;
        idx.df = new Map(Object.entries(data.df));
        idx.docs = data.docs.map(d => ({ id: d.id, tf: new Map(Object.entries(d.tf)), length: d.length }));
        return idx;
    }
}
