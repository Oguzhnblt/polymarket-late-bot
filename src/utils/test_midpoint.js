
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

async function test() {
    const signer = new Wallet('0000000000000000000000000000000000000000000000000000000000000001');
    const client = new ClobClient('https://clob.polymarket.com', 137, signer);

    const tokenId = '24080243798490121843498430658258926502184522944845560757959110268482950494311';
    try {
        const mp = await client.getMidpoint(tokenId);
        console.log('Midpoint Response:', JSON.stringify(mp, null, 2));
    } catch (err) {
        console.error('Error:', err.message);
    }
}
test();
