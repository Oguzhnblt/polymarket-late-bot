/**
 * dominanceExecutor.js
 * Executes and manages trades for the Dominance mode.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getUsdcBalance } from './client.js';
import { getLatestPrice } from './wsPriceWatcher.js';
import { getReferencePriceState } from './referencePriceFeed.js';
import { checkMarketResolution, checkOnChainPayout, redeemPosition } from './redeemer.js';
import logger from '../utils/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const activePositions = new Map(); // conditionId -> pos
const invalidationSince = new Map(); // conditionId -> timestamp
let virtualBalance = 1000; // Starting paper balance
let stats = {
    totalTrades: 0,
    successfulTrades: 0,
    totalPnl: 0,
    trades: [] // Last 10 trades for display
};

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

function clearInvalidation(conditionId) {
    invalidationSince.delete(conditionId);
}

function recordClosedTrade(pos, exitPrice, type) {
    const pnl = (exitPrice - pos.entryPrice) * pos.shares;

    if (config.dryRun) {
        virtualBalance += pos.shares * exitPrice;
    }

    stats.totalPnl += pnl;
    stats.totalTrades++;
    if (pnl > 0) {
        stats.successfulTrades++;
    }
    stats.trades.push({
        asset: pos.asset,
        pnl,
        exitPrice,
        type,
        time: new Date().toLocaleTimeString(),
    });
    if (stats.trades.length > 10) {
        stats.trades.shift();
    }

    return pnl;
}

function recordResolvedTrade(pos, payoutFraction, type) {
    const returned = payoutFraction * pos.shares;
    const pnl = returned - pos.totalCost;

    if (config.dryRun) {
        virtualBalance += returned;
    }

    stats.totalPnl += pnl;
    stats.totalTrades++;
    if (payoutFraction > 0) {
        stats.successfulTrades++;
    }
    stats.trades.push({
        asset: pos.asset,
        pnl,
        exitPrice: returned,
        type,
        time: new Date().toLocaleTimeString(),
    });
    if (stats.trades.length > 10) {
        stats.trades.shift();
    }

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

        const refState = getReferencePriceState(pos.asset);
        if (refState?.currentPrice > 0 && refState?.openPrice > 0) {
            const refDeltaBps = ((refState.currentPrice - refState.openPrice) / refState.openPrice) * 10000;
            const invalidated = pos.direction === 'YES'
                ? refDeltaBps <= -config.dominanceRefInvalidationBps
                : refDeltaBps >= config.dominanceRefInvalidationBps;
            if (invalidated) {
                if (!invalidationSince.has(pos.conditionId)) {
                    invalidationSince.set(pos.conditionId, Date.now());
                }
            } else {
                clearInvalidation(pos.conditionId);
            }

            if (
                invalidated &&
                Date.now() - invalidationSince.get(pos.conditionId) >= config.dominanceRefInvalidationConfirmMs
            ) {
                logger.warn(
                    `Trend oracle invalidation: ${pos.asset.toUpperCase()} ${pos.direction} | ` +
                    `ref ${refDeltaBps >= 0 ? '+' : ''}${refDeltaBps.toFixed(1)}bps vs open`,
                );
                const res = await marketSell(pos.tokenId, pos.shares, pos.tickSize, pos.negRisk);
                if (res.success) {
                    const pnl = recordClosedTrade(pos, res.price, 'ORACLE');
                    logger.warn(`Trend oracle exit executed @ $${res.price.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
                    break;
                }
            }
        }

        // 1. Check Take Profit
        if (currentPrice >= config.dominanceTPCutoff) {
            logger.money(`Trend TP Triggered: Price ${currentPrice.toFixed(3)} >= ${config.dominanceTPCutoff} | ${label}`);
            const res = await marketSell(pos.tokenId, pos.shares, pos.tickSize, pos.negRisk);
            if (res.success) {
                const pnl = recordClosedTrade(pos, res.price, 'TP');
                logger.money(`Trend TP Executed @ $${res.price.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
                break;
            }
        }

        // 2. Panic floor: last-resort protection against a broken market or feed
        const safetyCutoff = config.dominanceStopLossCutoff;
        if (safetyCutoff > 0 && currentPrice < safetyCutoff) {
            logger.warn(`Trend panic floor triggered: Price ${currentPrice.toFixed(3)} < ${safetyCutoff} | ${label}`);
            const res = await marketSell(pos.tokenId, pos.shares, pos.tickSize, pos.negRisk);
            if (res.success) {
                const pnl = recordClosedTrade(pos, res.price, 'PANIC');
                logger.warn(`Trend panic floor executed @ $${res.price.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
                break;
            }
        }

        // 3. Time-based exit for trend positions
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

        await sleep(2000);
    }

    clearInvalidation(pos.conditionId);
    activePositions.delete(pos.conditionId);
}

export async function executeDominanceStrategy(results, direction) {
    const perAssetSize = config.dominanceTradeSize;
    const totalTradeSize = perAssetSize * results.length;

    logger.info(
        `Executing Dominance Strategy: ${direction} direction | ` +
        `${results.length} assets × $${perAssetSize.toFixed(2)} = $${totalTradeSize.toFixed(2)}`,
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

    for (const res of results) {
        const m = res.market;
        const tokenId = direction === 'YES' ? m.yesTokenId : m.noTokenId;

        logger.trade(`Trend BUY: ${m.asset.toUpperCase()} ${direction} | Per-asset size: $${perAssetSize.toFixed(2)}`);

        const buyRes = await marketBuy(tokenId, perAssetSize, m.tickSize, m.negRisk);
        if (buyRes.success) {
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
                resolving: false,
                resolvingSince: 0,
            };
            activePositions.set(m.conditionId, pos);
            monitorPosition(pos); // non-blocking
            logger.success(`Trend entry confirmed: ${m.asset.toUpperCase()} @ $${buyRes.price.toFixed(3)} | ${buyRes.shares.toFixed(2)} shares`);
        } else {
            logger.error(`Trend entry failed for ${m.asset.toUpperCase()}`);
        }
    }
}
