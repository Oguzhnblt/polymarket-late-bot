
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const signer = new Wallet('0000000000000000000000000000000000000000000000000000000000000001');
const client = new ClobClient('https://clob.polymarket.com', 137, signer);

console.log('Available methods:', Object.keys(client));
if (client.createWebsocketClient) {
    console.log('Found createWebsocketClient');
}
if (client.getWebsocketUrl) {
    console.log('Websocket URL:', client.getWebsocketUrl());
}
