export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

// Must be at least 3. Increasing this reduces tree depth but makes each index
// page larger; lowering it creates more, smaller pages.
export const B_TREE_MAX_KEYS = 128;
export const B_TREE_PAGE_CACHE_SIZE = 256;
export const B_TREE_WRITE_CONCURRENCY = 32;

export const COLLECTION_LOCK_RETRY_MS = 10;
export const COLLECTION_LOCK_TIMEOUT_MS = 30_000;
export const COLLECTION_LOCK_STALE_MS = 30_000;
