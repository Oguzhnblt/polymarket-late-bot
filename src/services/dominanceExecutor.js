/**
 * dominanceExecutor.js
 * Executes and manages trades for the Dominance mode.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getUsdcBalance } from './client.js';
import { getMarketTokenState } from './marketChannel.js';
import { getLatestPrice } from './wsPriceWatcher.js';
import { checkMarketResolution, checkOnChainPayout, redeemPosition } from './redeemer.js';
import { appendTradeHistory, loadTradeHistory } from './tradeHistory.js';
import logger from '../utils/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const activePositions = new Map(); // conditionId -> pos
const MAX_RECENT_TRADES = 10;

function pickTakeProfitPct() {
    const minPct = config.dominanceTpPctMin;
    const maxPct = config.dominanceTpPctMax;
    if (maxPct <= minPct) return minPct;
    return minPct + (Math.random() * (maxPct - minPct));
}

function buildTakeProfitTarget(entryPrice) {
    const takeProfitPct = pickTakeProfitPct();
    const desiredPrice = entryPrice * (1 + takeProfitPct);
    const takeProfitPrice = Math.min(desiredPrice, config.dominanceTPCutoff);
    const effectivePct = entryPrice > 0 ? ((takeProfitPrice / entryPrice) - 1) : 0;
    return {
        takeProfitPct,
        takeProfitPrice,
        effectivePct,
        cappedByCutoff: takeProfitPrice < desiredPrice,
    };
}

function formatTradeTime(closedAt) {
    if (!closedAt) return new Date().toLocaleTimeString();
    const dt = new Date(closedAt);
    if (Number.isNaN(dt.getTime())) return new Date().toLocaleTimeString();
    return dt.toLocaleTimeString();
}

function toRecentTrade(entry) {
    return {
        asset: entry.asset,
        pnl: Number(entry.pnl) || 0,
        exitPrice: Number(entry.exitPrice) || 0,
        type: entry.type || 'UNKNOWN',
        direction: entry.direction || '',
        time: formatTradeTime(entry.closedAt),
    };
}

function buildStatsFromHistory(entries) {
    const totalTrades = entries.length;
    const successfulTrades = entries.filter((entry) => Number(entry.pnl) > 0).length;
    const totalPnl = entries.reduce((sum, entry) => sum + (Number(entry.pnl) || 0), 0);
    const trades = entries.slice(-MAX_RECENT_TRADES).map(toRecentTrade);

    return { totalTrades, successfulTrades, totalPnl, trades };
}

const persistedTrades = loadTradeHistory();
let virtualBalance = 1000 + persistedTrades.reduce((sum, entry) => sum + (Number(entry.pnl) || 0), 0);
let stats = buildStatsFromHistory(persistedTrades);

function isGatewayError(err) {
    const msg = [err?.message, err?.response?.statusText, err?.response?.data?.error]
        .filter(Boolean)
        .join(' ');
    return /\b502\b|bad gateway/i.test(msg);
}

export function getStats() {
    return {
        balance: config.dryRun ? virtualBalance : 'Real Balance',
        activeCount: activePositions.size,
        ...stats
    };
}

export function getActiveDominancePositions() {
    return Array.from(activePositions.values());
}

function registerClosedTrade(entry) {
    appendTradeHistory(entry);

    stats.totalPnl += entry.pnl;
    stats.totalTrades++;
    if (entry.pnl > 0) {
        stats.successfulTrades++;
    }
    stats.trades.push(toRecentTrade(entry));
    if (stats.trades.length > MAX_RECENT_TRADES) {
        stats.trades.shift();
    }
}

function recordClosedTrade(pos, exitPrice, type) {
    const pnl = (exitPrice - pos.entryPrice) * pos.shares;

    if (config.dryRun) {
        virtualBalance += pos.shares * exitPrice;
    }

    registerClosedTrade({
        asset: pos.asset,
        direction: pos.direction,
        pnl,
        exitPrice,
        type,
        entryPrice: pos.entryPrice,
        shares: pos.shares,
        conditionId: pos.conditionId,
        tokenId: pos.tokenId,
        question: pos.question,
        mode: 'ORACLE_FOLLOW',
        closeKind: 'MARKET_EXIT',
        closedAt: new Date().toISOString(),
    });

    return pnl;
}

function recordResolvedTrade(pos, payoutFraction, type) {
    const returned = payoutFraction * pos.shares;
    const pnl = returned - pos.totalCost;

    if (config.dryRun) {
        virtualBalance += returned;
    }

    registerClosedTrade({
        asset: pos.asset,
        direction: pos.direction,
        pnl,
        exitPrice: returned,
        type,
        entryPrice: pos.entryPrice,
        shares: pos.shares,
        payoutFraction,
        conditionId: pos.conditionId,
        tokenId: pos.tokenId,
        question: pos.question,
        mode: 'ORACLE_FOLLOW',
        closeKind: 'RESOLUTION',
        closedAt: new Date().toISOString(),
    });

    return { pnl, returned };
}

async function getMidprice(tokenId) {
    // 1. Try WebSocket cache
    const wsPrice = getLatestPrice(tokenId);
    if (wsPrice > 0) return wsPrice;

    // 2. Fallback to API
    try {
        const mp = await getClient().getMidpoint(tokenId);
        return parseFloat(mp?.mid ?? mp ?? '0') || 0;
    } catch (err) {
        if (isGatewayError(err)) {
            logger.warn(`CLOB 502 during getMidpoint [dominanceExecutor] | token=${tokenId}`);
        }
        return 0;
    }
}

async function marketBuy(tokenId, amountUSDC, tickSize, negRisk) {
    if (config.dryRun) {
        const price = await getMidprice(tokenId);
        return { success: true, price: price || 0.5, shares: amountUSDC / (price || 0.5) };
    }

    const client = getClient();
    try {
        const res = await client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.BUY, amount: amountUSDC, price: 0.99 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (!res?.success) return { success: false };
        return {
            success: true,
            price: parseFloat(res.price || '0'),
            shares: parseFloat(res.takingAmount || '0')
        };
    } catch (err) {
        if (isGatewayError(err)) {
            logger.warn(`CLOB 502 during createAndPostMarketOrder BUY | token=${tokenId}`);
        }
        logger.error('Dominance buy error:', err.message);
        return { success: false };
    }
}

async function marketSell(tokenId, shares, tickSize, negRisk) {
    if (config.dryRun) {
        const price = await getMidprice(tokenId);
        return { success: true, price: price || 0.8 };
    }

    const client = getClient();
    try {
        const res = await client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.SELL, amount: shares, price: 0.01 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (!res?.success) return { success: false };
        return { success: true, price: parseFloat(res.price || '0') };
    } catch (err) {
        if (isGatewayError(err)) {
            logger.warn(`CLOB 502 during createAndPostMarketOrder SELL | token=${tokenId}`);
        }
        logger.error('Dominance sell error:', err.message);
        return { success: false };
    }
}

async function settleExpiredPosition(pos) {
    const label = pos.question.substring(0, 40);
    const tradeLabel = `${pos.asset.toUpperCase()} ${pos.direction}`;
    pos.resolving = true;
    pos.resolvingSince = Date.now();
    logger.warn(`Trend expiry reached — waiting for resolution: ${label}`);

    while (true) {
        const resolution = await checkMarketResolution(pos.conditionId);
        if (!resolution?.resolved) {
            await sleep(5000);
            continue;
        }

        const onChain = await checkOnChainPayout(pos.conditionId);
        if (!onChain.resolved) {
            await sleep(5000);
            continue;
        }

        const outcomeIdx = pos.direction === 'YES' ? 0 : 1;
        const payoutFraction = onChain.payouts[outcomeIdx] ?? 0;
        const { pnl, returned } = recordResolvedTrade(pos, payoutFraction, 'EXPIRY');

        if (!config.dryRun && payoutFraction > 0) {
            const redeemed = await redeemPosition(pos.conditionId);
            if (!redeemed) {
                logger.error(`Trend redeem failed after resolution: ${label}`);
                return false;
            }
        }

        if (payoutFraction > 0) {
            logger.money(
                `Trend resolved WIN: ${tradeLabel} @ payout ${payoutFraction.toFixed(2)} | ` +
                `returned $${returned.toFixed(2)} | P&L: $${pnl.toFixed(2)}`,
            );
        } else {
            logger.warn(
                `Trend resolved LOSS: ${tradeLabel} | returned $0.00 | P&L: $${pnl.toFixed(2)}`,
            );
        }
        return true;
    }
}

function evaluateBookExit(pos, currentPrice) {
    const state = getMarketTokenState(pos.tokenId);
    if (!state || !state.bookTimestamp) return null;

    const bookAgeMs = Date.now() - state.bookTimestamp;
    if (bookAgeMs > config.dominanceMaxBookAgeMs) return null;

    const reasons = [];
    const displayPrice = Number(currentPrice) || 0;
    const currentBidSize = Number(state.bestBidSize) || 0;

    if (pos.entryPrice <= 0 || displayPrice <= 0) {
        return null;
    }

    const priceDropPct = (pos.entryPrice - displayPrice) / pos.entryPrice;
    if (priceDropPct < config.dominanceBookExitPriceDropPct) {
        return null;
    }

    reasons.push(`price -${(priceDropPct * 100).toFixed(1)}%`);

    if (priceDropPct >= config.dominanceHardExitPriceDropPct) {
        reasons.push('hard-exit');
        return { reasons, triggerPrice: displayPrice, priceDropPct };
    }

    if (pos.entryBestBidSize > 0 && currentBidSize >= 0) {
        const bidSizeRatio = currentBidSize / pos.entryBestBidSize;
        if (bidSizeRatio <= config.dominanceBookExitMinBidSizeRatio) {
            reasons.push(`bidSize x${bidSizeRatio.toFixed(2)}`);
        }
    }

    if (reasons.length < 2) {
        return null;
    }

    return { reasons, triggerPrice: displayPrice, priceDropPct };
}

async function monitorPosition(pos) {
    const label = pos.question.substring(0, 40);
    logger.info(`Monitoring trend position: ${label} (${pos.direction})`);

    while (true) {
        const msRemaining = new Date(pos.endTime).getTime() - Date.now();
        if (msRemaining <= 0) {
            const settled = await settleExpiredPosition(pos);
            if (!settled) {
                logger.error(`Trend settlement failed: ${label}`);
            }
            break;
        }

        const currentPrice = await getMidprice(pos.tokenId);
        if (currentPrice === 0) {
            await sleep(5000);
            continue;
        }

        const bookExit = evaluateBookExit(pos, currentPrice);
        if (bookExit) {
            logger.warn(
                `Trend book exit triggered: ${pos.asset.toUpperCase()} ${pos.direction} | ` +
                `triggerPx $${bookExit.triggerPrice.toFixed(3)} vs entry $${pos.entryPrice.toFixed(3)} | ` +
                `${bookExit.reasons.join(' | ')}`,
            );
            const res = await marketSell(pos.tokenId, pos.shares, pos.tickSize, pos.negRisk);
            if (res.success) {
                const pnl = recordClosedTrade(pos, res.price, 'BOOK');
                logger.warn(`Trend book exit executed @ $${res.price.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
                break;
            }
        }

        // 1. Check Take Profit
        if (currentPrice >= pos.takeProfitPrice) {
            logger.money(
                `Trend TP Triggered: Price ${currentPrice.toFixed(3)} >= ${pos.takeProfitPrice.toFixed(3)} | ` +
                `${label} | target +${(pos.effectiveTakeProfitPct * 100).toFixed(1)}%`,
            );
            const res = await marketSell(pos.tokenId, pos.shares, pos.tickSize, pos.negRisk);
            if (res.success) {
                const pnl = recordClosedTrade(pos, res.price, 'TP');
                logger.money(`Trend TP Executed @ $${res.price.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
                break;
            }
        }

        // 2. Time-based exit for trend positions
        if (config.dominanceTimeCutSec > 0 && msRemaining <= config.dominanceTimeCutSec * 1000) {
            logger.warn(`Trend time cut triggered — ${label}`);
            const res = await marketSell(pos.tokenId, pos.shares, pos.tickSize, pos.negRisk);
            if (res.success) {
                const pnl = recordClosedTrade(pos, res.price, 'TIME');
                logger.warn(`Trend time cut executed @ $${res.price.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
                break;
            }
            break;
        }

        await sleep(1000);
    }

    activePositions.delete(pos.conditionId);
}

export async function executeDominanceStrategy(results, direction) {
    const sizedResults = results.map((res) => ({
        ...res,
        tradeSize: config.dominanceTradeSize,
    }));
    const totalTradeSize = sizedResults.reduce((sum, res) => sum + res.tradeSize, 0);

    logger.info(
        `Executing Dominance Strategy: ${direction} direction | ` +
        `${sizedResults.length} assets | total $${totalTradeSize.toFixed(2)}`,
    );

    if (!config.dryRun) {
        const balance = await getUsdcBalance();
        if (balance < totalTradeSize) {
            logger.error(`Insufficient balance for dominance strategy: $${balance.toFixed(2)} < $${totalTradeSize}`);
            return;
        }
    } else {
        if (virtualBalance < totalTradeSize) {
            logger.error(`Insufficient virtual balance: $${virtualBalance.toFixed(2)} < $${totalTradeSize}`);
            return;
        }
        virtualBalance -= totalTradeSize;
    }

    for (const res of sizedResults) {
        const m = res.market;
        const tokenId = direction === 'YES' ? m.yesTokenId : m.noTokenId;
        const tradeSize = res.tradeSize;

        logger.trade(`Trend BUY: ${m.asset.toUpperCase()} ${direction} | Size: $${tradeSize.toFixed(2)}`);

        const buyRes = await marketBuy(tokenId, tradeSize, m.tickSize, m.negRisk);
        if (buyRes.success) {
            const tpTarget = buildTakeProfitTarget(buyRes.price);
            const pos = {
                conditionId: m.conditionId,
                question: m.question,
                asset: m.asset,
                direction,
                tokenId,
                shares: buyRes.shares,
                entryPrice: buyRes.price,
                totalCost: buyRes.shares * buyRes.price,
                refPrice: res.refPrice || 0,
                refOpenPrice: res.refOpenPrice || 0,
                refDeltaBps: res.refDeltaBps || 0,
                endTime: m.endTime,
                tickSize: m.tickSize,
                negRisk: m.negRisk,
                entryTime: Date.now(),
                entryBestBid: Number(getMarketTokenState(tokenId)?.bestBid) || 0,
                entryBestBidSize: Number(getMarketTokenState(tokenId)?.bestBidSize) || 0,
                takeProfitPrice: tpTarget.takeProfitPrice,
                takeProfitPct: tpTarget.takeProfitPct,
                effectiveTakeProfitPct: tpTarget.effectivePct,
                takeProfitCapped: tpTarget.cappedByCutoff,
                resolving: false,
                resolvingSince: 0,
            };
            activePositions.set(m.conditionId, pos);
            monitorPosition(pos); // non-blocking
            logger.success(
                `Trend entry confirmed: ${m.asset.toUpperCase()} @ $${buyRes.price.toFixed(3)} | ` +
                `${buyRes.shares.toFixed(2)} shares | TP $${pos.takeProfitPrice.toFixed(3)} ` +
                `(+${(pos.effectiveTakeProfitPct * 100).toFixed(1)}%${pos.takeProfitCapped ? ', capped' : ''})`,
            );
        } else {
            logger.error(`Trend entry failed for ${m.asset.toUpperCase()}`);
            if (config.dryRun) {
                virtualBalance += tradeSize;
            }
        }
    }
}
