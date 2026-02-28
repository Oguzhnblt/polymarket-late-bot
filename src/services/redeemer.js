import { ethers } from 'ethers';
import config from '../config/index.js';
import { getPolygonProvider } from './client.js';
import { execSafeCall, CTF_ADDRESS, USDC_ADDRESS } from './ctf.js';
import logger from '../utils/logger.js';

const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

export async function checkMarketResolution(conditionId) {
    try {
        const url = `${config.gammaHost}/markets?condition_id=${conditionId}`;
        const response = await fetch(url);
        if (!response.ok) return null;

        const markets = await response.json();
        if (!Array.isArray(markets) || markets.length === 0) return null;

        const market = markets[0];
        return {
            resolved: Boolean(market.closed || market.resolved),
            active: market.active,
            question: market.question,
        };
    } catch (err) {
        logger.error('Failed to check market resolution:', err.message);
        return null;
    }
}

export async function checkOnChainPayout(conditionId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

        const denominator = await ctf.payoutDenominator(conditionId);
        if (denominator.isZero()) {
            return { resolved: false, payouts: [] };
        }

        const payouts = [];
        for (let i = 0; i < 2; i++) {
            const numerator = await ctf.payoutNumerators(conditionId, i);
            payouts.push(numerator.toNumber() / denominator.toNumber());
        }

        return { resolved: true, payouts };
    } catch {
        return { resolved: false, payouts: [] };
    }
}

export async function redeemPosition(conditionId) {
    try {
        const ctfIface = new ethers.utils.Interface(CTF_ABI);
        const data = ctfIface.encodeFunctionData('redeemPositions', [
            USDC_ADDRESS,
            ethers.constants.HashZero,
            conditionId,
            [1, 2],
        ]);

        const label = `${conditionId.slice(0, 12)}...`;
        logger.info(`Redeeming position: ${label}`);
        const receipt = await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`);
        logger.success(`Redeemed in block ${receipt.blockNumber}`);
        return true;
    } catch (err) {
        logger.error(`Failed to redeem: ${err.message}`);
        return false;
    }
}
