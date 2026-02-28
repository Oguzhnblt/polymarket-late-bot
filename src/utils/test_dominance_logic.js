/**
 * test_dominance_logic.js
 * Standalone unit test for Dominance Detection logic.
 */

const mockMarkets = [
    { asset: 'btc', yesTokenId: '1', noTokenId: '2', question: 'BTC up?' },
    { asset: 'eth', yesTokenId: '3', noTokenId: '4', question: 'ETH up?' },
];

function checkDominanceLogic(results, assets, entryCutoff) {
    const scores = { yes: 0, no: 0 };
    for (const r of results) {
        if (r.yesPrice >= entryCutoff) scores.yes++;
        if (r.noPrice >= entryCutoff) scores.no++;
    }

    if (scores.yes === assets.length) return 'YES';
    if (scores.no === assets.length) return 'NO';
    return null;
}

const DEFAULT_CUTOFF = 0.65;

// Test Case 1: Dominance YES
const results1 = [
    { market: mockMarkets[0], yesPrice: 0.70, noPrice: 0.30 },
    { market: mockMarkets[1], yesPrice: 0.80, noPrice: 0.20 },
];
const dir1 = checkDominanceLogic(results1, mockMarkets, DEFAULT_CUTOFF);
console.log(`Test 1 (YES Dominance): ${dir1 === 'YES' ? 'PASSED' : 'FAILED'} (Result: ${dir1})`);

// Test Case 2: No Dominance
const results2 = [
    { market: mockMarkets[0], yesPrice: 0.70, noPrice: 0.30 },
    { market: mockMarkets[1], yesPrice: 0.50, noPrice: 0.50 },
];
const dir2 = checkDominanceLogic(results2, mockMarkets, DEFAULT_CUTOFF);
console.log(`Test 2 (No Dominance): ${dir2 === null ? 'PASSED' : 'FAILED'} (Result: ${dir2})`);

// Test Case 3: Dominance NO
const results3 = [
    { market: mockMarkets[0], yesPrice: 0.20, noPrice: 0.80 },
    { market: mockMarkets[1], yesPrice: 0.10, noPrice: 0.90 },
];
const dir3 = checkDominanceLogic(results3, mockMarkets, DEFAULT_CUTOFF);
console.log(`Test 3 (NO Dominance): ${dir3 === 'NO' ? 'PASSED' : 'FAILED'} (Result: ${dir3})`);

if (dir1 === 'YES' && dir2 === null && dir3 === 'NO') {
    console.log('\nALL LOGIC TESTS PASSED!');
} else {
    console.log('\nSOME TESTS FAILED!');
    process.exit(1);
}
