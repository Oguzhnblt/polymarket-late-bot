/**
 * wsPriceWatcher.js
 * Optimized Price Manager: Uses high-frequency polling to simulate real-time updates.
 * (Falls back to polling as the CLOB WebSocket URL may vary by region/API version).
 */

import { getClient } from './client.js';
import logger from '../utils/logger.js';

const POLL_INTERVAL_MS = 200;
let pollTimer = null;
const priceCache = new Map(); // tokenId -> latestPrice
const subscriptions = new Set(); // set of tokenIds

function isGatewayError(err) {
    const msg = [err?.message, err?.response?.statusText, err?.response?.data?.error]
        .filter(Boolean)
        .join(' ');
    return /\b502\b|bad gateway/i.test(msg);
}

async function updatePrices() {
    if (subscriptions.size === 0) return;

    const tokenIds = Array.from(subscriptions);
    const client = getClient();

    // Fetch all prices in parallel for minimum latency
    await Promise.allSettled(tokenIds.map(async (id) => {
        try {
            const mp = await client.getMidpoint(id);
            const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
            if (price > 0) {
                priceCache.set(id, price);
            }
        } catch (err) {
            if (isGatewayError(err)) {
                logger.warn(`CLOB 502 during getMidpoint [wsPriceWatcher] | token=${id}`);
            }
        }
    }));
}

/**
 * Start high-frequency polling
 */
function startManager() {
    if (pollTimer) return;

    logger.info(`Starting Price Manager (High-Frequency Polling: ${POLL_INTERVAL_MS}ms)...`);
    updatePrices();
    pollTimer = setInterval(updatePrices, POLL_INTERVAL_MS);
}

function stopManager() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Price Manager stopped');
}

/**
 * Subscribe to price updates for a set of tokens
 * @param {string[]} tokenIds 
 */
export function subscribePrices(tokenIds) {
    tokenIds.forEach(id => subscriptions.add(id));
    startManager();
}

/**
 * Unsubscribe from price updates for a set of tokens
 * @param {string[]} tokenIds
 */
export function unsubscribePrices(tokenIds) {
    tokenIds.forEach((id) => {
        subscriptions.delete(id);
        priceCache.delete(id);
    });

    if (subscriptions.size === 0) {
        stopManager();
    }
}

/**
 * Get the latest cached price for a token
 * @param {string} tokenId 
 */
export function getLatestPrice(tokenId) {
    return priceCache.get(tokenId) || 0;
}

/**
 * Stop the price manager
 */
export function stopPriceWatcher() {
    subscriptions.clear();
    priceCache.clear();
    stopManager();
}
