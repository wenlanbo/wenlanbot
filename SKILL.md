---
name: 42space-trading
title: "42.space Prediction Market Trading on BSC"
description: "Complete guide for AI agents to trade prediction market outcome tokens on 42.space (BNB Smart Chain). Covers market mechanics, REST API for data queries, on-chain trading via smart contracts, and optional integrations with 0x (token swaps) and Privy (managed wallets with gas sponsorship)."
tags: [prediction-markets, bsc, trading, defi, web3, ethers, 42space, bonding-curve]
version: "2.0.0"
---

# 42.space Prediction Market Trading

A complete, agent-agnostic guide. Any AI agent with terminal access and Node.js can use this to discover, analyze, and trade prediction markets on 42.space.

---

## 1. How 42.space Works

### What Is It?

42.space is a **prediction market protocol** on **BNB Smart Chain (BSC)**. Users trade **outcome tokens** for real-world events — elections, crypto prices, sports, product launches, etc.

### The Bonding Curve Mechanism

Unlike traditional exchanges with orderbooks, 42.space uses a **power bonding curve** for pricing:

- **No counterparty needed.** You buy from and sell to the curve itself (a smart contract).
- **Price rises with demand.** As more tokens are minted (bought) for an outcome, the price increases along the curve. Selling (redeeming) pushes it back down.
- **Continuous liquidity.** You can always buy or sell — there's no need to find a matching order.
- **Price = implied probability.** A token priced at **0.30 USDT** implies the market thinks there's a **~30% chance** that outcome wins.

### Multi-Outcome Markets

Markets are NOT limited to Yes/No. A single market can have **2 to 10+ outcomes**:

```
"Who will win the 2026 NBA MVP?"
  Token 0: (reserved/null)     — price: ~0.00 USDT
  Token 1: Luka Doncic         — price: 0.28 USDT (28% probability)
  Token 2: Nikola Jokic        — price: 0.22 USDT (22% probability)
  Token 3: Jayson Tatum        — price: 0.15 USDT (15% probability)
  ...
```

Each outcome is a separate token identified by a **tokenId** (0-indexed integer).

### Outcome Tokens (OT)

- Follow the **ERC6909** standard (multi-token, similar to ERC1155 but simpler)
- Held directly on the market contract: `market.balanceOf(walletAddress, tokenId)`
- Denominated in 18 decimals (like ETH wei)
- **Tick size:** `0.01e18` (10000000000000000 wei) — all OT amounts must be multiples of this

### Market Lifecycle

```
live → ended → resolved → finalised
```

1. **Live:** Trading is open. Buy and sell freely.
2. **Ended:** Trading window closed. No new trades.
3. **Resolved:** Admin sets the winning outcome.
4. **Finalised:** Challenge period passed. Winners can claim.

### Settlement

When a market is **finalised**, holders of the **winning outcome token** can claim approximately **1 USDT per token** (minus the protocol fee, typically 0.8%).

### Key Numbers

| Parameter | Value |
|-----------|-------|
| **Chain** | BNB Smart Chain (Chain ID: 56) |
| **Collateral** | USDT (BEP-20) — **18 decimals** (NOT 6 like Ethereum USDT) |
| **Fee rate** | ~0.8% (8000000000000000 / 1e18) |
| **Tick size** | 0.01e18 (10000000000000000 wei) |
| **Market URL** | `https://www.42.space/event/{contract_address}` |

---

## 2. REST API — Querying Market Data

The 42.space REST API provides read-only access to all market data. **No authentication required.**

### Base URL

```
https://rest.ft.42.space
```

All endpoints are **GET** requests returning JSON with `{data, pagination}` structure.

### 2.1 Market Discovery

**List live markets by volume:**
```bash
curl -s "https://rest.ft.42.space/api/v1/markets?status=live&order=volume&limit=10"
```

| Parameter | Values |
|-----------|--------|
| `status` | `live`, `ended`, `resolved`, `finalised` |
| `category` | Filter by category name |
| `order` | `volume` (descending) |
| `limit` | Max results (up to 500) |
| `offset` | Pagination offset |

**Get a specific market:**
```bash
curl -s "https://rest.ft.42.space/api/v1/markets/{market_address}"
```

**List all outcome tokens for a market (KEY ENDPOINT):**
```bash
curl -s "https://rest.ft.42.space/api/v1/markets/tokens?market_address={address}"
```

This returns each outcome's `tokenId`, `name`, `price`, `volume`, `marketCap`, `mintedQuantity`, and `symbol`. **Use this to know what you're buying.**

**Market timeline (lifecycle events):**
```bash
curl -s "https://rest.ft.42.space/api/v1/markets/{address}/timeline"
```

**All categories:**
```bash
curl -s "https://rest.ft.42.space/api/v1/markets/categories"
```

### Market Data Schema (Key Fields)

```
address             — on-chain contract address (use this for trading)
questionId          — bytes32 identifier
question            — human-readable question text
description         — detailed description with resolution criteria
slug                — URL-friendly identifier
collateralAddress   — USDT contract address
curve               — bonding curve contract address
startDate, endDate  — market open/close timestamps
status              — live / ended / resolved / finalised
resolvedAnswer      — winning tokenId (after resolution)
totalMarketCap      — total value locked
volume              — total trading volume in USDT
traders             — number of unique traders
categories[]        — category tags
outcomes[]:
  tokenId           — integer ID (use this for on-chain calls)
  name              — outcome name (e.g., "Yes", "Luka Doncic")
  index             — same as tokenId
  price             — current price in USDT (0.0 to 1.0)
  volume            — outcome-specific volume
  marketCap         — outcome-specific market cap
  payout            — payout per token after resolution
  mintedQuantity    — total OT supply
  symbol            — token symbol string
```

### 2.2 Pricing & Charts

**Current prices for all outcomes:**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/prices?market={address}"
```

**Price history:**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/prices/history?market={address}&outcome_index=0&duration=24h"
# Durations: 1h, 4h, 24h, 7d, 30d, 90d, 1y, all
```

**OHLCV candles:**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/ohlc?market={address}&outcome_index=0&interval=1d"
# Intervals: 10s, 1m, 3m, 30m, 2h, 6h, 12h, 1d
```

### 2.3 Token Stats & Holders

**Token stats with price/volume deltas:**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/tokens/stats?status=live&order_by=volume&limit=100"
```
Returns `statsChanges` with `priceChange1h`, `priceChange4h`, `volumeChange1h`, `volumeChange24h` — useful for alerts and scanning.

**Batch market stats (up to 50):**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/stats?markets={addr1},{addr2}"
```

**Token holder distribution:**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/holders?market={address}&outcome_index=0"
```
Returns: `userAddress`, `amount`, `avgPrice`, `currentPrice`, `realizedPnl`, `unrealizedPnl`.

### 2.4 Portfolio & Activity

**Open positions (with unrealized PnL):**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/positions?user={wallet_address}"
```

**Closed positions (realized PnL):**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/closed-positions?user={wallet_address}"
```

**Activity feed (trade history):**
```bash
curl -s "https://rest.ft.42.space/api/v1/market-data/activity?user={wallet_address}"
# Event types: MINT (buy), REDEEM (sell), FINALISE, CLAIM
```

### 2.5 Leaderboard

```bash
# Top traders by PnL
curl -s "https://rest.ft.42.space/api/v1/market-data/leaderboard?sort_by=pnl&period=7d&limit=20"

# Single wallet stats
curl -s "https://rest.ft.42.space/api/v1/market-data/leaderboard/wallet-stats?wallet={address}"

# Top trades globally
curl -s "https://rest.ft.42.space/api/v1/market-data/leaderboard/top-trades?period=7d"
```

### Common Workflow: Find a Market and Its Outcomes

```bash
# Step 1: Find live markets
curl -s "https://rest.ft.42.space/api/v1/markets?status=live&order=volume&limit=5" | jq '.data[0]'

# Step 2: Get the market address from the response, then list its outcome tokens
curl -s "https://rest.ft.42.space/api/v1/markets/tokens?market_address=0x4E44AC67..." | jq '.data[] | {tokenId, name, price, volume}'

# Step 3: Check your positions
curl -s "https://rest.ft.42.space/api/v1/market-data/positions?user=0xYOUR_WALLET"
```

---

## 3. On-Chain Trading — Smart Contracts

### 3.0 Requirements

- **Node.js** >= 18
- **ethers.js** v6: `npm install ethers`
- A BSC wallet with:
  - **BNB** for gas (~0.01 BNB per trade ≈ $0.03)
  - **USDT (BEP-20)** for trading
- **RPC endpoint:** `https://bsc-dataseed1.binance.org` (public, free)
- Store private keys in **environment variables**, never hardcode them

### 3.1 Contract Addresses (BSC Mainnet)

| Contract | Address | Role |
|----------|---------|------|
| **Router** | `0x88888888338e60bfB4657187169cFFa5c8640E42` | Entry point for all trades (multicall) |
| **Factory** | `0xF21b2D4F8989b27f732e369907F25f0E8D95Fe62` | Market registry, config, question data |
| **Curve** | `0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da` | Bonding curve pricing engine |
| **USDT** | `0x55d398326f99059fF775485246999027B3197955` | Collateral (BEP-20, 18 decimals) |

Architecture:
```
User → Router (multicall) → Market (ERC6909 tokens)
                          → Curve (pricing)
       Factory (registry) → Market config / question data
```

### 3.2 Setup

```javascript
const { ethers } = require("ethers");

const RPC         = "https://bsc-dataseed1.binance.org";
const PRIVATE_KEY = process.env.BSC_PRIVATE_KEY;       // NEVER hardcode
const WALLET      = process.env.BSC_WALLET_ADDRESS;

const ROUTER_ADDR = "0x88888888338e60bfB4657187169cFFa5c8640E42";
const CURVE_ADDR  = "0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da";
const USDT_ADDR   = "0x55d398326f99059fF775485246999027B3197955";

// Load ABIs (see references/ directory for full JSON files)
const ROUTER_ABI  = require("./references/router-abi.json");
const FACTORY_ABI = require("./references/factory-abi.json");
const CURVE_ABI   = require("./references/curve-abi.json");

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];
const ERC6909_ABI = [
  "function balanceOf(address owner, uint256 id) view returns (uint256)"
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
const router   = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, wallet);
const curve    = new ethers.Contract(CURVE_ADDR, CURVE_ABI, provider);
```

### 3.3 Get the Factory

```javascript
const factoryAddr = await router.controller();
const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
```

### 3.4 Read Market Info

```javascript
const market = "0x4E44AC673bcc315cD97424CaEfCF9CcCC8eAcA6b"; // example

// Verify it's a real 42.space market
const isReal = await factory.isMarket(market); // true or false

// Get config
const config = await factory.getConfig(market);
// Returns: _treasury, _feeRate, _numOutcomes, _timestampEnd, _answer, _isFinalised
console.log("Outcomes:", Number(config._numOutcomes));
console.log("End:", new Date(Number(config._timestampEnd) * 1000));
console.log("Finalised:", config._isFinalised);
```

### 3.5 Read Prices

```javascript
// Marginal price of a specific outcome token
const price = await curve.calMarginalPrice(market, tokenId);
console.log("Price:", ethers.formatUnits(price, 18), "USDT");

// Full market state
const state = await curve.readMarketState(market, tokenId);
console.log("OT supply:", ethers.formatUnits(state.otCurrent, 18));
console.log("Tick:", state.tick.toString());
console.log("Fee rate:", state.feeRate.toString());
```

### 3.6 Get Price Quotes

**How many OT for X USDT?**
```javascript
const usdtIn = ethers.parseUnits("10", 18); // 10 USDT
const [otDelta, actualCost] = await curve.calOtDeltaByMintCost(
  market, tokenId, usdtIn, "0x"  // CRITICAL: pass "0x" for data param
);
console.log("You'd get:", ethers.formatUnits(otDelta, 18), "OT");
console.log("Actual cost:", ethers.formatUnits(actualCost, 18), "USDT");
```

**How much USDT to buy X OT?**
```javascript
const otAmount = ethers.parseUnits("1000", 18);
const [costFromUser, feeToTreasury] = await curve.calMintCostByOtDelta(
  market, tokenId, otAmount, "0x"
);
console.log("Cost:", ethers.formatUnits(costFromUser, 18), "USDT");
```

**Sell quote (how much USDT you'd get back):**
```javascript
const [collateralBack, sellFee] = await curve.calRedeemValueByOtDelta(
  market, tokenId, otAmount, "0x"
);
console.log("You'd receive:", ethers.formatUnits(collateralBack, 18), "USDT");
```

### 3.7 Approve USDT (One-Time)

```javascript
const usdt = new ethers.Contract(USDT_ADDR, ERC20_ABI, wallet);
const allowance = await usdt.allowance(WALLET, ROUTER_ADDR);
if (allowance === 0n) {
  const tx = await usdt.approve(ROUTER_ADDR, ethers.MaxUint256);
  await tx.wait();
}
```

### 3.8 Buy Outcome Tokens

Buying uses `multicall` with **two batched operations**:

```javascript
const amountIn = ethers.parseUnits("10", 18); // 10 USDT
const tokenId  = 1; // which outcome to buy

const iface = new ethers.Interface(ROUTER_ABI);

// Operation 1: Pull USDT from wallet into Router
const transferCall = iface.encodeFunctionData("erc20TransferFromInitiator", [
  USDT_ADDR, ROUTER_ADDR, amountIn
]);

// Operation 2: Swap USDT → Outcome Tokens
const swapCall = iface.encodeFunctionData("swapSimple", [
  market,                            // market address
  WALLET,                            // receiver
  tokenId,                           // outcome tokenId
  {                                  // SwapParams struct
    isMint: true,                    // true = buy
    amount: amountIn,                // USDT to spend
    isExactIn: true,                 // exact input
    minOutOrMaxIn: 0n                // slippage (0 = none, set for production)
  },
  "0x",                              // dataSwap  — MUST be "0x"
  "0x"                               // dataGuess — MUST be "0x"
]);

// Execute atomically
const calls = [
  { allowFailure: false, callData: transferCall },
  { allowFailure: false, callData: swapCall }
];

const tx = await router.multicall(calls, { gasLimit: 800000 });
const receipt = await tx.wait();
console.log("Bought! TX:", tx.hash);
```

### 3.9 Check Your Position

```javascript
const marketContract = new ethers.Contract(market, ERC6909_ABI, provider);
const balance = await marketContract.balanceOf(WALLET, tokenId);
console.log("Balance:", ethers.formatUnits(balance, 18), "OT");
```

### 3.10 Sell Outcome Tokens

Selling requires only **one multicall operation** (no transfer needed):

```javascript
const otToSell = ethers.parseUnits("100", 18);

const swapCall = iface.encodeFunctionData("swapSimple", [
  market, WALLET, tokenId,
  {
    isMint: false,       // false = sell
    amount: otToSell,
    isExactIn: true,
    minOutOrMaxIn: 0n    // minimum USDT to accept
  },
  "0x", "0x"
]);

const tx = await router.multicall(
  [{ allowFailure: false, callData: swapCall }],
  { gasLimit: 800000 }
);
await tx.wait();
```

### 3.11 Claim Winnings

After a market is finalised:

```javascript
const config = await factory.getConfig(market);
if (config._isFinalised) {
  const tx = await router.claimAllSimple(market, WALLET);
  await tx.wait();
  console.log("Winnings claimed!");
}
```

### Function Reference

**Router (user-facing):**

| Function | Purpose |
|----------|---------|
| `multicall(Call[])` | Batch operations atomically |
| `swapSimple(market, receiver, tokenId, SwapParams, dataSwap, dataGuess)` | Buy or sell |
| `erc20TransferFromInitiator(token, receiver, amount)` | Pull ERC20 into Router |
| `claimAllSimple(market, receiver)` | Claim all winnings |
| `claimSimple(market, receiver, tokenIds[], otToBurn[])` | Claim specific |
| `controller()` | Returns Factory address |

**Factory (read-only for traders):**

| Function | Purpose |
|----------|---------|
| `getConfig(market)` | feeRate, numOutcomes, endTime, answer, isFinalised |
| `isMarket(market)` | Verify address is a real market |
| `getQuestion(questionId)` | Title, description, outcome names |
| `getOutcomeNames(questionId)` | Array of outcome name strings |
| `isFinalised(questionId)` | Whether resolution is final |

**Curve (pricing):**

| Function | Purpose |
|----------|---------|
| `calMarginalPrice(market, tokenId)` | Current price per OT |
| `calOtDeltaByMintCost(market, tokenId, collateral, "0x")` | OT you'd get for X USDT |
| `calMintCostByOtDelta(market, tokenId, otDelta, "0x")` | USDT cost for X OT |
| `calRedeemValueByOtDelta(market, tokenId, otDelta, "0x")` | USDT from selling X OT |
| `calOtDeltaByRedeemValue(market, tokenId, collateral, "0x")` | OT to sell for X USDT |
| `readMarketState(market, tokenId)` | Full state: otCurrent, tick, feeRate |
| `tick()` | Minimum OT increment (0.01e18) |

**All `bytes` params in Curve functions: always pass `"0x"` (empty bytes).**

### ABI Files

Full JSON ABIs are in the `references/` directory:
- `references/router-abi.json` — Router (9 functions)
- `references/factory-abi.json` — Factory (44 functions, 3 events)
- `references/curve-abi.json` — Curve (19 functions)

### Ready-to-Use Script

`scripts/trade.js` is a complete CLI tool:

```
node trade.js                            # wallet status
node trade.js info <market>              # market details + all outcome prices
node trade.js quote <market> <id> [amt]  # price quote
node trade.js buy <market> <id> <usdt>   # buy outcome tokens
node trade.js sell <market> <id> <ot>    # sell outcome tokens
node trade.js claim <market>             # claim winnings
```

Configure via environment variables: `BSC_PRIVATE_KEY` and `BSC_WALLET_ADDRESS`.

---

## 4. Critical Pitfalls

### 1. USDT has 18 decimals on BSC (NOT 6)
On Ethereum USDT has 6 decimals. On BSC it has **18**. Always use `ethers.parseUnits(amount, 18)`.

### 2. dataSwap and dataGuess MUST be "0x"
The `swapSimple` function takes `bytes dataSwap` and `bytes dataGuess`. **Always pass `"0x"`**. Passing encoded structs reverts with `GuessInvalidDataLength`.

### 3. OT amounts must be tick-aligned
Tick = `0.01e18`. The `calOtDeltaByMintCost` function returns tick-aligned values automatically.

### 4. Buy requires TWO multicall operations
`erc20TransferFromInitiator` + `swapSimple`. Without the transfer, the Router has no collateral.

### 5. Sell only needs ONE operation
Just `swapSimple(isMint=false)`. No separate token transfer.

### 6. gasLimit should be ~800000
Bonding curve math is gas-intensive. Default estimation may undercount.

### 7. BSC public RPCs rate-limit getLogs
Use the REST API (Section 2) for market discovery instead of scanning events on-chain.

### 8. tokenId 0 often has zero supply
Active outcomes typically start at tokenId 1. Token 0 is a default/null state.

### 9. Address checksum enforcement
ethers.js v6 enforces EIP-55. Fix with `ethers.getAddress(addr.toLowerCase())`.

### 10. Use slippage protection in production
Set `minOutOrMaxIn` in SwapParams to protect against price movement and sandwich attacks.

---

## 5. (Optional) 0x Swap API — Token Swaps on BSC

Use [0x](https://0x.org) to swap any BSC tokens (e.g., BNB ↔ USDT) with DEX-aggregated best prices.

### When to Use
- Convert BNB to USDT for prediction market trading
- Swap between any BEP-20 tokens
- Get best price across PancakeSwap, SushiSwap, and 150+ DEXes

### Setup
1. Get API key at [dashboard.0x.org](https://dashboard.0x.org/create-account)
2. Required headers: `0x-api-key: YOUR_KEY` and `0x-version: v2`

### Get a Price Quote

```bash
curl "https://api.0x.org/swap/allowance-holder/price?\
chainId=56&\
sellToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&\
buyToken=0x55d398326f99059fF775485246999027B3197955&\
sellAmount=10000000000000000&\
taker=0xYOUR_WALLET" \
  -H "0x-api-key: YOUR_KEY" \
  -H "0x-version: v2"
```

### Execute a Swap

```bash
# 1. Get executable quote
curl "https://api.0x.org/swap/allowance-holder/quote?..." \
  -H "0x-api-key: YOUR_KEY" -H "0x-version: v2"

# 2. Response includes a `transaction` object with to, data, value, gas
# 3. Approve AllowanceHolder (0x0000000000001fF3684f28c67538d4D072C22734)
# 4. Sign and submit the transaction
```

### Key Details

| Item | Value |
|------|-------|
| **Base URL** | `https://api.0x.org` |
| **BSC chain ID** | `56` |
| **AllowanceHolder** | `0x0000000000001fF3684f28c67538d4D072C22734` |
| **Rate limit** | 5 RPS (free tier) |
| **Native token** | Use `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` for BNB |
| **Cross-chain** | Private beta only — same-chain swaps only |

---

## 6. (Optional) Privy — Managed Wallets & Gas Sponsorship

Use [Privy](https://privy.io) for secure managed wallets instead of raw private keys. Keys are secured in TEEs and never exposed. Supports policy guardrails (spending limits, contract allowlists).

### Option A: Agent CLI (Simple)

Best for quick setup — no API keys needed, login via browser.

**Install:**
```bash
npm install -g @privy-io/agent-wallet-cli
```

**Login (two-step):**
```bash
# Step 1: Initiate — opens browser URL for authentication
npx @privy-io/agent-wallet-cli login --non-interactive

# Step 2: User authenticates in browser, copies JSON credentials, then:
npx @privy-io/agent-wallet-cli login --non-interactive '{"ethereum":{"wallet_id":"...","address":"0x..."},"solana":{"wallet_id":"...","address":"..."}}'
```

**List wallets:**
```bash
npx @privy-io/agent-wallet-cli list-wallets
```

**Send a BSC transaction:**
```bash
npx @privy-io/agent-wallet-cli rpc --json '{
  "method": "eth_sendTransaction",
  "caip2": "eip155:56",
  "params": {
    "transaction": {
      "to": "0xCONTRACT_ADDRESS",
      "value": "0x0",
      "data": "0xCALLDATA_HERE"
    }
  }
}'
```

**Session info:**
- Stored at `~/.privy/session.json` (encrypted)
- Expires after **7 days** — re-login needed
- Backup: `cp ~/.privy/session.json ~/.privy/session.backup.json`

### Option B: Server Wallets API (Full Control)

Best for production — full policy enforcement, gas sponsorship, programmatic access.

**Setup:**
1. Create account at [dashboard.privy.io](https://dashboard.privy.io)
2. Get **App ID** and **App Secret**

**Create a wallet:**
```bash
curl -X POST "https://api.privy.io/v1/wallets" \
  -u "YOUR_APP_ID:YOUR_APP_SECRET" \
  -H "privy-app-id: YOUR_APP_ID" \
  -H "Content-Type: application/json" \
  -d '{"chain_type": "ethereum"}'
```

**Send a transaction:**
```bash
curl -X POST "https://api.privy.io/v1/wallets/WALLET_ID/rpc" \
  -u "YOUR_APP_ID:YOUR_APP_SECRET" \
  -H "privy-app-id: YOUR_APP_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "eth_sendTransaction",
    "caip2": "eip155:56",
    "params": {
      "transaction": {
        "to": "0x88888888338e60bfB4657187169cFFa5c8640E42",
        "value": "0x0",
        "data": "0xMULTICALL_DATA"
      }
    }
  }'
```

### Gas Sponsorship (Pay Gas with USDT, No BNB Needed)

With gas sponsorship enabled, Privy's paymaster covers BNB gas fees — your wallet only needs USDT.

**Setup:**
1. Go to [dashboard.privy.io](https://dashboard.privy.io) → your app
2. Open the **Gas Sponsorship** tab
3. Enable sponsorship and select **BNB Smart Chain**
4. Add gas credits (deposit funds)
5. Note: your organization must be **7+ days old**

**Use:** Add `"sponsor": true` to the RPC body:
```bash
curl -X POST "https://api.privy.io/v1/wallets/WALLET_ID/rpc" \
  -u "APP_ID:APP_SECRET" \
  -H "privy-app-id: APP_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "eth_sendTransaction",
    "caip2": "eip155:56",
    "sponsor": true,
    "params": {
      "transaction": {
        "to": "0x88888888338e60bfB4657187169cFFa5c8640E42",
        "value": "0x0",
        "data": "0xMULTICALL_DATA"
      }
    }
  }'
```

The Agent CLI also supports `sponsor`:
```bash
npx @privy-io/agent-wallet-cli rpc --json '{
  "method": "eth_sendTransaction",
  "caip2": "eip155:56",
  "sponsor": true,
  "params": {
    "transaction": { "to": "0x...", "value": "0x0", "data": "0x..." }
  }
}'
```

**Without sponsorship:** Keep ~0.01 BNB in the wallet for gas. Covers 300+ trades.

---

## 7. Monitoring & Alerting

The `scripts/monitor.js` tool provides real-time monitoring of 42 markets with configurable alerts via Slack and/or Telegram.

### What It Monitors

| Monitor | Description | Default Threshold |
|---------|-------------|-------------------|
| **Price movements** | Alerts when any outcome token price changes significantly | ±10% |
| **Volume spikes** | Detects unusual trading activity on outcomes | +200% in 1h |
| **New markets** | Notifies when new markets appear with volume | >$100 volume |
| **Markets ending** | Warns before a market's trading window closes | 24h before |
| **Position PnL** | Tracks your open positions for profit/loss thresholds | +50% / -20% |
| **Resolved markets** | Alerts when markets resolve or finalise | Immediate |
| **Whale trades** | Detects large trades in the last hour | >$500 |

### Usage

```bash
# Single scan (ideal for cron)
node scripts/monitor.js run

# Continuous monitoring (runs every 5 min by default)
node scripts/monitor.js watch

# Check monitor state and recent alerts
node scripts/monitor.js status

# Reset state (start fresh)
node scripts/monitor.js reset
```

### Environment Variables

```bash
# Required for position monitoring
export BSC_WALLET_ADDRESS="0xYOUR_WALLET"

# Alert destinations (one or both)
export SLACK_WEBHOOK="https://hooks.slack.com/services/..."
export TELEGRAM_BOT_TOKEN="your_bot_token"
export TELEGRAM_CHAT_ID="your_chat_id"

# Tuning (all optional)
export MONITOR_INTERVAL=300       # seconds between scans in watch mode
export PRICE_CHANGE_PCT=10        # % price change to alert
export VOLUME_SPIKE_PCT=200       # % volume spike to alert
export PNL_LOSS_PCT=20            # % unrealized loss to alert
export PNL_PROFIT_PCT=50          # % unrealized profit to alert
export NEW_MARKET_MIN_VOL=100     # min $ volume for new market alert
export MARKET_ENDING_HOURS=24     # hours before end to alert
```

### Running as Cron Job

```bash
# Scan every 5 minutes
*/5 * * * * cd /path/to/wenlanbot && node scripts/monitor.js run >> /tmp/42-monitor.log 2>&1
```

### Running as Systemd Service

```ini
# /etc/systemd/system/42-monitor.service
[Unit]
Description=42 Market Monitor
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/wenlanbot/scripts/monitor.js watch
Restart=always
Environment=BSC_WALLET_ADDRESS=0xYOUR_WALLET
Environment=SLACK_WEBHOOK=https://hooks.slack.com/services/...

[Install]
WantedBy=multi-user.target
```

### Alert Format

Alerts are sent with emoji icons for quick scanning:

- 📈 Price movements
- 🔥 Volume spikes
- 🆕 New markets
- ⏰ Markets ending soon
- 💰 Position in profit
- 🔻 Position at loss
- ✅ Market resolved
- 🏁 Market finalised
- 🐋 Whale trades

### State Management

The monitor maintains state in `monitor-state.json` to avoid duplicate alerts:
- Price snapshots for delta calculation
- Known markets to detect new ones
- Alert deduplication keys
- Last 200 alerts for history

State persists across restarts. Use `monitor.js reset` to start fresh.
