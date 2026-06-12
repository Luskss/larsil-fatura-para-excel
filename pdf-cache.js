/**
 * pdf-cache.js
 * Cache em memória para PDFs processados.
 * Armazena até 500MB de PDFs em memória.
 * Limpeza automática de antigos quando limite é atingido.
 */
'use strict';

const MAX_CACHE_SIZE = 500 * 1024 * 1024; // 500MB
let _cache = new Map(); // key → { data, size, timestamp }
let _totalSize = 0;

/**
 * Gera chave única para o PDF
 */
function generateKey(arquivo, pasta) {
    return `${arquivo}|${pasta || ''}`;
}

/**
 * Armazena um PDF no cache
 */
function put(arquivo, pasta, pdfBuffer) {
    const key = generateKey(arquivo, pasta);
    const size = pdfBuffer.length;

    // Remove entrada antiga se existir
    if (_cache.has(key)) {
        _totalSize -= _cache.get(key).size;
    }

    // Se ultrapassaria o limite, limpa entradas antigas
    if (_totalSize + size > MAX_CACHE_SIZE) {
        evictOldest();
    }

    _cache.set(key, {
        data: pdfBuffer,
        size: size,
        timestamp: Date.now(),
    });
    _totalSize += size;

    console.log(`[pdf-cache] armazenado ${arquivo} (${(size / 1024 / 1024).toFixed(2)}MB) — total: ${(_totalSize / 1024 / 1024).toFixed(2)}MB`);
}

/**
 * Recupera um PDF do cache
 */
function get(arquivo, pasta) {
    const key = generateKey(arquivo, pasta);
    const entry = _cache.get(key);
    if (entry) {
        entry.timestamp = Date.now(); // atualiza timestamp (LRU)
        return entry.data;
    }
    return null;
}

/**
 * Remove entradas antigas quando cache está cheio
 */
function evictOldest() {
    // Remove 10% de entradas mais antigas
    const entriesToRemove = Math.max(1, Math.floor(_cache.size * 0.1));
    const sorted = Array.from(_cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

    for (let i = 0; i < entriesToRemove; i++) {
        const [key, entry] = sorted[i];
        _cache.delete(key);
        _totalSize -= entry.size;
        console.log(`[pdf-cache] removido (cache cheio): ${key}`);
    }
}

/**
 * Retorna estatísticas do cache
 */
function stats() {
    return {
        entries: _cache.size,
        totalSizeMB: (_totalSize / 1024 / 1024).toFixed(2),
        maxSizeMB: (MAX_CACHE_SIZE / 1024 / 1024).toFixed(0),
    };
}

/**
 * Limpa todo o cache
 */
function clear() {
    _cache.clear();
    _totalSize = 0;
    console.log('[pdf-cache] cache limpo');
}

module.exports = { put, get, stats, clear };
