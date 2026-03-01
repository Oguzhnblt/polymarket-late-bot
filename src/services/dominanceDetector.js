/**
 * dominanceDetector.js
 * Detects if a "dominant direction" exists across a group of related coins.
 * Uses deterministic slug construction similar to mmDetector.js.
 * WS-Enabled: Uses real-time prices from wsPriceWatcher.js.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { getClient } from './client.js';
import { getMarketTokenState, stopMarketChannel, subscribeMarketTokens, unsubscribeMarketTokens } from './marketChannel.js';
import { getLatestPrice, subscribePrices, unsubscribePrices } from './wsPriceWatcher.js';
import { getReferencePriceState, startReferencePriceFeed, stopReferencePriceFeed } from './referencePriceFeed.js';

// Slot size in seconds (300 for 5m, 900 for 15m)
const SLOT_SEC = config.dominanceDuration === '15m' ? 900 : 300;
const DETECTOR_POLL_MS = 200;
const PRICE_EPSILON = 1e-6;

let pollTimer = null;
let onDominanceCb = null;
const seenKeys = new Set(); // `dominance-${slot}-${asset}` already processed
const sourceWarnedKeys = new Set(); // `dominance-${slot}-${asset}` mismatch/missing source already logged
const tickSizeWarnedKeys = new Set(); // `dominance-${slot}-${asset}` tick-size saturation already logged
const liquidityWarnedKeys = new Set(); // `dominance-${slot}-${asset}-${direction}` spread/top-size skip already logged
const staleBookWarnedKeys = new Set(); // `dominance-${slot}-${asset}-${direction}` stale-book skip already logged
const trackedTokenIds = new Set();
const marketCacheBySlot = new Map(); // `dominance-${slot}` -> extracted market data[]
const refSignalSince = new Map(); // `${slotKey}-${asset}-${direction}` -> timestamp
let currentMarketPrices = []; // [{ asset, price, direction }]

export function getMarketPrices() {
    return currentMarketPrices;
}

function currentSlot() {
    return Math.floor(Date.now() / 1000 / SLOT_SEC) * SLOT_SEC;
}

function extractSlotFromKey(key) {
    const slot = Number(key.replace('dominance-', ''));
    return Number.isFinite(slot) ? slot : null;
}

function cleanupStaleState(activeSlot) {
    for (const key of Array.from(marketCacheBySlot.keys())) {
        const slot = extractSlotFromKey(key);
        if (slot === null || slot >= activeSlot) continue;

        const staleMarkets = marketCacheBySlot.get(key) || [];
        unsubscribePrices(staleMarkets.flatMap((market) => [market.yesTokenId, market.noTokenId]));
        unsubscribeMarketTokens(staleMarkets.flatMap((market) => [market.yesTokenId, market.noTokenId]));
        staleMarkets.forEach((market) => {
            trackedTokenIds.delete(market.yesTokenId);
            trackedTokenIds.delete(market.noTokenId);
        });
        marketCacheBySlot.delete(key);
        for (const market of staleMarkets) {
            seenKeys.delete(`${key}-${market.asset}`);
            sourceWarnedKeys.delete(`${key}-${market.asset}`);
            tickSizeWarnedKeys.delete(`${key}-${market.asset}`);
            liquidityWarnedKeys.delete(`${key}-${market.asset}-YES`);
            liquidityWarnedKeys.delete(`${key}-${market.asset}-NO`);
            staleBookWarnedKeys.delete(`${key}-${market.asset}-YES`);
            staleBookWarnedKeys.delete(`${key}-${market.asset}-NO`);
            refSignalSince.delete(`${key}-${market.asset}-YES`);
            refSignalSince.delete(`${key}-${market.asset}-NO`);
        }
    }
}

function normalizeStreamSlug(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^\/+|\/+$/g, '');
}

function extractResolutionSourceUrl(market) {
    return String(
        market.resolutionSource
        || market.resolution_source
        || market.resolutionSourceUrl
        || market.resolution_source_url
        || '',
    ).trim();
}

function extractChainlinkStreamSlug(sourceUrl) {
    const match = String(sourceUrl || '')
        .toLowerCase()
        .match(/data\.chain\.link\/streams\/([^/?#]+)/);
    return match ? normalizeStreamSlug(match[1]) : '';
}

function isGatewayError(err) {
    const msg = [err?.message, err?.response?.statusText, err?.response?.data?.error]
        .filter(Boolean)
        .join(' ');
    return /\b502\b|bad gateway/i.test(msg);
}

async function fetchBySlug(asset, slotTimestamp) {
    const slug = `${asset}-updown-${config.dominanceDuration}-${slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch {
        return null;
    }
}

function extractMarketData(market, asset) {
    const conditionId = market.conditionId || market.condition_id || '';
    if (!conditionId) return null;

    let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
    }

    let yesTokenId, noTokenId;
    if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        [yesTokenId, noTokenId] = tokenIds;
    } else if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
        yesTokenId = market.tokens[0]?.token_id ?? market.tokens[0]?.tokenId;
        noTokenId = market.tokens[1]?.token_id ?? market.tokens[1]?.tokenId;
    }

    if (!yesTokenId || !noTokenId) return null;

    return {
        asset,
        conditionId,
        question: market.question || market.title || '',
        endTime: market.endDate || market.end_date_iso || market.endDateIso,
        eventStartTime: market.eventStartTime || market.event_start_time,
        yesTokenId: String(yesTokenId),
        noTokenId: String(noTokenId),
        negRisk: market.negRisk ?? market.neg_risk ?? false,
        tickSize: String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? market.minimumTickSize ?? '0.01'),
        resolutionSource: extractResolutionSourceUrl(market),
        resolutionStream: extractChainlinkStreamSlug(extractResolutionSourceUrl(market)),
    };
}

async function getTokenPrice(tokenId) {
    const wsPrice = getLatestPrice(tokenId);
    if (wsPrice > 0) {
        return wsPrice;
    }
    try {
        const mp = await getClient().getMidpoint(tokenId);
        return parseFloat(mp?.mid ?? mp ?? '0') || 0;
    } catch (err) {
        if (isGatewayError(err)) {
            logger.warn(`CLOB 502 during getMidpoint [dominanceDetector] | token=${tokenId}`);
        }
        return 0;
    }
}

function buildDisplayDirection(yesPrice, noPrice) {
    if (yesPrice >= config.dominanceEntryCutoff) return 'YES';
    if (noPrice >= config.dominanceEntryCutoff) return 'NO';
    return 'NEUTRAL';
}

function passesExecutionGuard(state) {
    if (!state) {
        return {
            spreadOk: false,
            topSizeOk: false,
            bookFreshOk: false,
            spread: null,
            topSize: 0,
            bookAgeMs: null,
        };
    }

    const spread = Number.isFinite(state.spread) ? state.spread : null;
    const topSize = Number(state.bestAskSize) || 0;
    const bookAgeMs = state.bookTimestamp > 0 ? Date.now() - state.bookTimestamp : null;

    return {
        spreadOk: spread !== null && spread <= (config.dominanceMaxSpread + PRICE_EPSILON),
        topSizeOk: topSize >= config.dominanceMinTopSize,
        bookFreshOk: bookAgeMs !== null && bookAgeMs <= config.dominanceMaxBookAgeMs,
        spread,
        topSize,
        bookAgeMs,
    };
}

function evaluateReferenceBias(asset, slotKey, msRemaining) {
    const refState = getReferencePriceState(asset);
    if (!refState || refState.currentPrice <= 0 || refState.openPrice <= 0) {
        return {
            refState,
            direction: 'NEUTRAL',
            deltaBps: 0,
            confirmed: false,
        };
    }

    const inWindow = msRemaining <= config.dominanceLateEntryWindowSec * 1000
        && msRemaining > config.dominanceMinTimeLeftSec * 1000;
    const direction = refState.deltaBps >= config.dominanceRefMoveBps
        ? 'YES'
        : refState.deltaBps <= -config.dominanceRefMoveBps
            ? 'NO'
            : 'NEUTRAL';
    const now = Date.now();

    if (!inWindow || direction === 'NEUTRAL') {
        refSignalSince.delete(`${slotKey}-${asset}-YES`);
        refSignalSince.delete(`${slotKey}-${asset}-NO`);
        return {
            refState,
            direction,
            deltaBps: refState.deltaBps,
            confirmed: false,
        };
    }

    const activeKey = `${slotKey}-${asset}-${direction}`;
    const oppositeKey = `${slotKey}-${asset}-${direction === 'YES' ? 'NO' : 'YES'}`;
    refSignalSince.delete(oppositeKey);
    if (!refSignalSince.has(activeKey)) {
        refSignalSince.set(activeKey, now);
    }

    return {
        refState,
        direction,
        deltaBps: refState.deltaBps,
        confirmed: now - refSignalSince.get(activeKey) >= config.dominanceRefConfirmMs,
    };
}

function getOracleEntryProfile(price) {
    if (price >= config.dominanceExtremePriceCutoff) {
        return {
            minRefMoveBps: config.dominanceExtremePriceRefMoveBps,
        };
    }
    if (price >= config.dominanceHighPriceCutoff) {
        return {
            minRefMoveBps: config.dominanceHighPriceRefMoveBps,
        };
    }
    return {
        minRefMoveBps: config.dominanceRefMoveBps,
    };
}

async function checkDominance() {
    try {
        const assets = config.dominanceAssets;
        const activeSlot = currentSlot();
        const slots = [activeSlot];
        cleanupStaleState(activeSlot);

        for (const slot of slots) {
            const key = `dominance-${slot}`;
            let markets = marketCacheBySlot.get(key) || [];

            if (markets.length === 0) {
                const discoveredMarkets = [];

                // 1. Fetch info for all assets in this slot
                for (const asset of assets) {
                    const market = await fetchBySlug(asset, slot);
                    if (market) {
                        const data = extractMarketData(market, asset);
                        if (data) {
                            discoveredMarkets.push(data);
                        }
                    }
                }

                if (discoveredMarkets.length < assets.length) continue;
                markets = discoveredMarkets;
                marketCacheBySlot.set(key, markets);
            }

            // Manage WS subscriptions
            for (const market of markets) {
                const tokenIds = [market.yesTokenId, market.noTokenId];
                const unseen = tokenIds.filter((tokenId) => !trackedTokenIds.has(tokenId));
                if (unseen.length > 0) {
                    subscribePrices(unseen);
                    subscribeMarketTokens(unseen);
                    unseen.forEach((tokenId) => trackedTokenIds.add(tokenId));
                }
            }

            currentMarketPrices = [];
            let logDetails = [];

            for (const m of markets) {
                const yesPrice = await getTokenPrice(m.yesTokenId);
                const noPrice = await getTokenPrice(m.noTokenId);
                const signalKey = `${key}-${m.asset}`;
                const expectedStream = normalizeStreamSlug(config.dominanceChainlinkStreams[m.asset]);
                const resolutionStream = normalizeStreamSlug(m.resolutionStream);
                const sourceAligned = Boolean(resolutionStream) && resolutionStream === expectedStream;
                const msRemaining = new Date(m.endTime).getTime() - Date.now();
                const refBias = evaluateReferenceBias(m.asset, key, msRemaining);
                const yesMarketState = getMarketTokenState(m.yesTokenId);
                const noMarketState = getMarketTokenState(m.noTokenId);
                const yesExecution = passesExecutionGuard(yesMarketState);
                const noExecution = passesExecutionGuard(noMarketState);
                const yesEntryProfile = getOracleEntryProfile(yesPrice);
                const noEntryProfile = getOracleEntryProfile(noPrice);
                const direction = refBias.direction === 'NEUTRAL'
                    ? buildDisplayDirection(yesPrice, noPrice)
                    : refBias.direction;
                const yesTickLocked = Boolean(yesMarketState?.tickSizeChanged);
                const noTickLocked = Boolean(noMarketState?.tickSizeChanged);
                const yesSignal = sourceAligned
                    && refBias.confirmed
                    && !yesTickLocked
                    && yesExecution.bookFreshOk
                    && yesExecution.spreadOk
                    && yesExecution.topSizeOk
                    && refBias.direction === 'YES'
                    && yesPrice >= config.dominanceEntryCutoff
                    && yesPrice <= config.dominanceMaxEntryPrice
                    && Math.abs(refBias.deltaBps) >= yesEntryProfile.minRefMoveBps;
                const noSignal = sourceAligned
                    && refBias.confirmed
                    && !noTickLocked
                    && noExecution.bookFreshOk
                    && noExecution.spreadOk
                    && noExecution.topSizeOk
                    && refBias.direction === 'NO'
                    && noPrice >= config.dominanceEntryCutoff
                    && noPrice <= config.dominanceMaxEntryPrice
                    && Math.abs(refBias.deltaBps) >= noEntryProfile.minRefMoveBps;

                currentMarketPrices.push({
                    asset: m.asset,
                    yesPrice,
                    noPrice,
                    price: yesPrice,
                    direction: yesSignal ? 'YES' : (noSignal ? 'NO' : direction),
                    question: m.question,
                    endTime: m.endTime,
                    conditionId: m.conditionId,
                    refPrice: refBias.refState?.currentPrice || 0,
                    refOpenPrice: refBias.refState?.openPrice || 0,
                    refDeltaBps: refBias.deltaBps || 0,
                    refConfirmed: refBias.confirmed,
                    resolutionSource: m.resolutionSource,
                    resolutionStream,
                    expectedResolutionStream: expectedStream,
                    sourceAligned,
                    yesTickSizeChanged: yesTickLocked,
                    noTickSizeChanged: noTickLocked,
                    yesSpread: yesExecution.spread,
                    noSpread: noExecution.spread,
                    yesTopSize: yesExecution.topSize,
                    noTopSize: noExecution.topSize,
                    yesBookAgeMs: yesExecution.bookAgeMs,
                    noBookAgeMs: noExecution.bookAgeMs,
                    yesRequiredRefMoveBps: yesEntryProfile.minRefMoveBps,
                    noRequiredRefMoveBps: noEntryProfile.minRefMoveBps,
                    executionOk: direction === 'NO'
                        ? noExecution.bookFreshOk && noExecution.spreadOk && noExecution.topSizeOk
                        : yesExecution.bookFreshOk && yesExecution.spreadOk && yesExecution.topSizeOk,
                });

                logDetails.push(
                    `${m.asset.toUpperCase()}: ` +
                    `UP $${yesPrice.toFixed(3)} | ` +
                    `DOWN $${noPrice.toFixed(3)} | ` +
                    `REF ${refBias.deltaBps >= 0 ? '+' : ''}${refBias.deltaBps.toFixed(1)}bps | ` +
                    `SRC ${sourceAligned ? resolutionStream : `${resolutionStream || 'missing'}!=${expectedStream}`} | ` +
                    `SPD ${direction === 'NO' ? noExecution.spread ?? 0 : yesExecution.spread ?? 0} | ` +
                    `TOP ${direction === 'NO' ? noExecution.topSize : yesExecution.topSize} | ` +
                    `AGE ${direction === 'NO' ? noExecution.bookAgeMs ?? -1 : yesExecution.bookAgeMs ?? -1}ms`,
                );

                if (!sourceAligned && !sourceWarnedKeys.has(signalKey)) {
                    logger.warn(
                        `Skipping ${m.asset.toUpperCase()}: resolution source mismatch | ` +
                        `market=${resolutionStream || 'missing'} expected=${expectedStream}`,
                    );
                    sourceWarnedKeys.add(signalKey);
                }

                if (yesTickLocked && !tickSizeWarnedKeys.has(`${signalKey}-YES`)) {
                    logger.warn(`Skipping ${m.asset.toUpperCase()} YES: tick_size_change triggered saturation lock`);
                    tickSizeWarnedKeys.add(`${signalKey}-YES`);
                }

                if (noTickLocked && !tickSizeWarnedKeys.has(`${signalKey}-NO`)) {
                    logger.warn(`Skipping ${m.asset.toUpperCase()} NO: tick_size_change triggered saturation lock`);
                    tickSizeWarnedKeys.add(`${signalKey}-NO`);
                }

                if (
                    refBias.direction === 'YES' &&
                    !yesExecution.bookFreshOk &&
                    !staleBookWarnedKeys.has(`${signalKey}-YES`)
                ) {
                    logger.warn(
                        `Skipping ${m.asset.toUpperCase()} YES: stale-book guard | ` +
                        `age=${yesExecution.bookAgeMs ?? 'n/a'}ms max=${config.dominanceMaxBookAgeMs}ms`,
                    );
                    staleBookWarnedKeys.add(`${signalKey}-YES`);
                }

                if (
                    refBias.direction === 'NO' &&
                    !noExecution.bookFreshOk &&
                    !staleBookWarnedKeys.has(`${signalKey}-NO`)
                ) {
                    logger.warn(
                        `Skipping ${m.asset.toUpperCase()} NO: stale-book guard | ` +
                        `age=${noExecution.bookAgeMs ?? 'n/a'}ms max=${config.dominanceMaxBookAgeMs}ms`,
                    );
                    staleBookWarnedKeys.add(`${signalKey}-NO`);
                }

                if (
                    refBias.direction === 'YES' &&
                    yesExecution.bookFreshOk &&
                    (!yesExecution.spreadOk || !yesExecution.topSizeOk) &&
                    !liquidityWarnedKeys.has(`${signalKey}-YES`)
                ) {
                    const reasons = [];
                    if (!yesExecution.spreadOk) {
                        reasons.push(
                            `spread=${yesExecution.spread?.toFixed(3) ?? 'n/a'} max=${config.dominanceMaxSpread.toFixed(3)}`,
                        );
                    }
                    if (!yesExecution.topSizeOk) {
                        reasons.push(
                            `top=${yesExecution.topSize.toFixed(2)} min=${config.dominanceMinTopSize.toFixed(2)}`,
                        );
                    }
                    logger.warn(
                        `Skipping ${m.asset.toUpperCase()} YES: execution guard | ${reasons.join(' | ')}`,
                    );
                    liquidityWarnedKeys.add(`${signalKey}-YES`);
                }

                if (
                    refBias.direction === 'NO' &&
                    noExecution.bookFreshOk &&
                    (!noExecution.spreadOk || !noExecution.topSizeOk) &&
                    !liquidityWarnedKeys.has(`${signalKey}-NO`)
                ) {
                    const reasons = [];
                    if (!noExecution.spreadOk) {
                        reasons.push(
                            `spread=${noExecution.spread?.toFixed(3) ?? 'n/a'} max=${config.dominanceMaxSpread.toFixed(3)}`,
                        );
                    }
                    if (!noExecution.topSizeOk) {
                        reasons.push(
                            `top=${noExecution.topSize.toFixed(2)} min=${config.dominanceMinTopSize.toFixed(2)}`,
                        );
                    }
                    logger.warn(
                        `Skipping ${m.asset.toUpperCase()} NO: execution guard | ${reasons.join(' | ')}`,
                    );
                    liquidityWarnedKeys.add(`${signalKey}-NO`);
                }

                if (yesSignal && !seenKeys.has(signalKey)) {
                    logger.success(
                        `Asset Oracle Follow: ${m.asset.toUpperCase()} YES | ` +
                        `UP $${yesPrice.toFixed(3)} | ref ${refBias.deltaBps.toFixed(1)}bps | ` +
                        `req ${yesEntryProfile.minRefMoveBps}bps | ` +
                        `src ${resolutionStream} | ` +
                        `${Math.round(msRemaining / 1000)}s left | Slot: ${slot}`,
                    );
                    seenKeys.add(signalKey);
                    if (onDominanceCb) {
                        onDominanceCb([{
                            market: m,
                            yesPrice,
                            noPrice,
                            refPrice: refBias.refState?.currentPrice || 0,
                            refOpenPrice: refBias.refState?.openPrice || 0,
                            refDeltaBps: refBias.deltaBps || 0,
                            resolutionSource: m.resolutionSource,
                            resolutionStream,
                        }], 'YES');
                    }
                    continue;
                }

                if (noSignal && !seenKeys.has(signalKey)) {
                    logger.success(
                        `Asset Oracle Follow: ${m.asset.toUpperCase()} NO | ` +
                        `DOWN $${noPrice.toFixed(3)} | ref ${refBias.deltaBps.toFixed(1)}bps | ` +
                        `req ${noEntryProfile.minRefMoveBps}bps | ` +
                        `src ${resolutionStream} | ` +
                        `${Math.round(msRemaining / 1000)}s left | Slot: ${slot}`,
                    );
                    seenKeys.add(signalKey);
                    if (onDominanceCb) {
                        onDominanceCb([{
                            market: m,
                            yesPrice,
                            noPrice,
                            refPrice: refBias.refState?.currentPrice || 0,
                            refOpenPrice: refBias.refState?.openPrice || 0,
                            refDeltaBps: refBias.deltaBps || 0,
                            resolutionSource: m.resolutionSource,
                            resolutionStream,
                        }], 'NO');
                    }
                }
            }

            if (Math.random() < 0.1) {
                logger.info(`Dominance Check [Slot ${slot}]: ${logDetails.join(' || ')}`);
            }
        }

    } catch (err) {
        logger.error('Dominance detector error:', err.message);
    }
}

export function startDominanceDetector(onDominance) {
    onDominanceCb = onDominance;
    seenKeys.clear();
    sourceWarnedKeys.clear();
    tickSizeWarnedKeys.clear();
    liquidityWarnedKeys.clear();
    staleBookWarnedKeys.clear();
    trackedTokenIds.clear();
    marketCacheBySlot.clear();
    refSignalSince.clear();
    startReferencePriceFeed();

    checkDominance();
    pollTimer = setInterval(checkDominance, DETECTOR_POLL_MS);

    logger.info(
        `Oracle-follow detector started (${DETECTOR_POLL_MS}ms) — ` +
        `assets: ${config.dominanceAssets.join(', ').toUpperCase()}`,
    );
}

export function stopDominanceDetector() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    cleanupStaleState(Number.MAX_SAFE_INTEGER);
    refSignalSince.clear();
    sourceWarnedKeys.clear();
    tickSizeWarnedKeys.clear();
    liquidityWarnedKeys.clear();
    staleBookWarnedKeys.clear();
    stopMarketChannel();
    stopReferencePriceFeed();
    currentMarketPrices = [];
}
