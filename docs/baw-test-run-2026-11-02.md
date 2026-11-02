# Test run: trading 42.space with a Binance Agentic Wallet (2026-11-02)

A record of the first end-to-end test: from no Agentic Wallet tooling at all to a
round trip on a 42 market (buy, then sell immediately), signed entirely by the Binance
Agentic Wallet (`baw`) with no private key. This is the raw material for the how-to guide.

- Wallet: a fresh Binance Agentic Wallet, funded with 100 USDT and about 0.042 BNB on BSC. The address and tx hashes are left out of this public log.
- Market: "HYPE vs BNB: Higher FDV on Dec 31st 2026?" `0xBeaccE47578aC8BFf2b8cE1c66D7Ab65C811691A`
- Outcome: BNB (tokenId 2). Picked arbitrarily for the test.
- Size: 1 USDT

## Part 1: One-time setup

### 1. Install the Binance Agentic Wallet skill

```bash
npx skills add binance/binance-skills-hub --skill binance-agentic-wallet -g -a claude-code -y
```

- This installs to `~/.claude/skills/binance-agentic-wallet` (skill v1.15.0, needs CLI ≥ 1.12.0).
- The installer shows security ratings: Gen "Critical Risk", Socket "1 alert", Snyk "Med Risk".
  This is expected for a skill that can move funds, but users should know about it.
- Without `-g -a <agent> -y` it asks where to install interactively.

### 2. Install the `baw` CLI (preflight)

```bash
npm install -g @binance/agentic-wallet@1.12.0
baw cli-check --required-version 1.12.0 --json      # needUpdateCli: false
baw skill-check --skill-name binance-agentic-wallet --current-version 1.15.0 --json
baw wallet status --json                             # UNCONNECTED
```

### 3. Sign in

```bash
baw auth signin --json
# -> { qrCodeId, urlForWeb, pairingCode, expireAt }
open "<urlForWeb>"                                   # scan QR in Binance App, check pairing code matches
baw auth verify --qrCodeId <qrCodeId> --json         # blocks until confirmed in App (5 min timeout)
baw wallet status --json                             # CONNECTED
```

- `auth verify` must keep running in the foreground until it returns. If it's killed, the
  session may not be saved locally even though the App says it succeeded.
- The session lasts 48h, and you're also signed out after 48h of inactivity. The hard maximum
  is 7 days, after which you must sign in again. Sign-out is silent, so the next command just fails.

Default settings observed after sign-in (`baw wallet settings --json`):

| Setting | Value |
|---|---|
| dailyLimit | 50,000 |
| devMode.enabled | **false** |
| devMode.dailyLimit | 1,000 |
| tradeAllTokens | false |
| predictionEnabled | false (Binance's own prediction markets, not 42) |
| abnormalTxnHandling | AutoReject |

### 4. Enable Developer Mode (required for 42)

42 trades are arbitrary contract calls (`baw contract-call`), and those only work in Developer Mode.
To turn it on in the Binance App: open the Agentic Wallet management page, tap Settings (top-right),
turn on Developer Mode, accept the Risk Warning, then approve the signature request.

Verify:

```bash
baw wallet settings --json   # devMode.enabled: true, expiresAt: +7 days
```

- It lasts 7 days, and each successful use extends it.
- It's refused (`351804`) if the wallet's total balance is above Binance's Developer Mode cap.
- `devMode.dailyLimit` was 1,000.

### 5. Fund the wallet

```bash
baw wallet address --json    # same EVM address on every EVM chain
```

- Send **USDT on BSC (BEP-20)**: `0x55d398326f99059fF775485246999027B3197955`. It has 18 decimals.
- You also need a little **BNB for gas**. The whole round trip below cost about 0.000046 BNB.
- **Gotcha:** after 100 USDT arrived on-chain, `baw wallet balance` still showed only BNB, probably
  because Binance's balance index lags or the list is limited to allowed tokens. Check the real
  balance on-chain with `USDT.balanceOf(wallet)`.

## Part 2: How a trade works

`baw` has no idea how 42 works. The pattern is the same one Binance uses for its own Agent ID
bonding-curve script:

1. **Read and build (local, no signing):** quote through the 42 Lens contract, check allowances,
   and encode the calldata with viem.
2. **`baw contract-call preview`:** Binance simulates the call, runs its risk checks, and returns a `requestId`.
3. **Show the preview to the user and get confirmation.**
4. **`baw contract-call execute --requestId <id>`:** this signs and sends the transaction and
   returns a `txHash` straight away (`BROADCASTED`).
5. **Wait for the receipt on-chain** (viem `waitForTransactionReceipt`). `baw` does not wait.

```bash
baw contract-call preview --binanceChainId 56 \
  --from <wallet> --to <contract> --value 0 --inputData <calldata> --json
baw contract-call execute --requestId <requestId> --json
```

Contracts used:

| Contract | Address |
|---|---|
| Router V2 | `0x888888886619275d33c00D3BC62DF94D700DCD42` |
| Lens V2 | `0x4AAd5A856941FB64df10362024e3Ece24023d4d1` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |

## Part 3: Buy (mint) 1 USDT of tokenId 2

### Quote

`Lens.simulateMint(market, 2, 1e18, true, "0x", dataGuess(0, 100, eps), 0)`:

| | |
|---|---|
| Expected OT | 31.51 |
| Min OT (5% slippage) | 29.9345 |
| Price before / after | 0.0314167 / 0.0314173 |
| Fee | 0.0099 USDT |

### Tx 1: approve USDT to the Router (exactly 1 USDT, not unlimited)

- calldata: `USDT.approve(Router, 1e18)`
- preview: `transactionType: Approve`, allowance 0 → 1e18, no risks, `requireConfirmation: false`
- mined ✅ (gas 46,194)

### Tx 2: buy

- calldata: `Router.swap(market, wallet, 2, {isMint: true, amount: 1e18, isExactIn: true, minOutOrMaxIn: minOt}, "0x", dataGuess(expectedOt, 50, eps), 0x0, 0)`
- preview: `transactionType: "sale"`. Binance doesn't understand 42's call and mislabels it, so ignore the label.
  USDT −0.99985, no risks, `requireConfirmation: false`
- mined ✅ (gas 321,708)
- Result: **31.51 OT** of tokenId 2. Spent 0.99985 USDT, leaving about 0.00015 USDT of unused allowance.

## Part 4: Sell (redeem) everything right back

### Quote

`Lens.simulateRedeem(market, 2, 31.51e18, true, "0x", "0x", 0)`:

| | |
|---|---|
| Expected USDT | **0.7637** |
| Min USDT (5% slippage) | 0.7255 |
| Fee | 0.0077 USDT |

### Tx 3: approve the outcome token to the Router (ERC-6909, exactly 31.51)

- calldata: `market.approve(Router, 2, 31.51e18)`. Note this ERC-6909 approve takes 3 arguments, unlike ERC-20's 2.
- preview: `transactionType: approve`, no risks, `requireConfirmation: false`
- mined ✅ (gas 46,866)

### Tx 4: sell

- calldata: `Router.swap(market, wallet, 2, {isMint: false, amount: 31.51e18, isExactIn: true, minOutOrMaxIn: minUsdt}, "0x", "0x", 0x0, 0)`
- preview: `transactionType: "sale"`, USDT +0.76365, no risks, `requireConfirmation: false`
- mined ✅ (gas 252,005)

## Result

| | Before | After | Δ |
|---|---|---|---|
| USDT | 100.000000 | 99.763802 | **−0.236198** |
| BNB | 0.041980658 | 0.041934386 | −0.000046 (4 txs of gas) |
| OT tokenId 2 | 0 | 0 | |
| USDT allowance → Router | 0 | 0.000151 | dust left from the buy |
| OT allowance → Router | 0 | 0 | |

Both directions work through `baw contract-call`, and no transaction needed confirmation in the App.

## Findings for the how-to

1. **An immediate round trip lost about 24%.** We paid 1 USDT and got 0.7638 back. The quoted
   marginal price (0.0314) is what you pay to buy, not what you get when you sell; the sell
   returned about 0.0242 per OT. The ~0.4% fee in SKILL.md doesn't explain it. We need to
   understand and document this curve asymmetry before telling beginners they can "always sell".
2. **Preview can't look ahead.** The buy can't be previewed until the approval is mined, because
   the simulation fails without the allowance. So each step goes preview → execute → wait for receipt → next.
3. **Binance's preview labels 42 swaps as "sale",** and doesn't show the ERC-6909 outcome tokens
   coming in or going out. Users have to rely on the Lens quote for the token side.
4. **`baw wallet balance` may not list USDT** even when it's in the wallet. Read it on-chain.
5. **Approve exact amounts.** `scripts/trade.ts` approves `MAX_UINT256`; for a beginner skill on an
   agent wallet, exact amounts are safer and cost about $0.003 of gas each.
6. **What can't work with `baw`:** `bebe-claim` and `undelegate`, because they need EIP-7702
   `signAuthorization` and `baw` has no equivalent. Plain `market.claim` should work but hasn't been tested yet.
7. **Naming:** SKILL.md says "`router.swapSimple`", but the working calls used `Router.swap(...)`
   with an 8-argument signature (as `scripts/trade.ts` does).
8. **Operational limits:** sessions last 48h and expire silently, Developer Mode lasts 7 days,
   and Developer Mode is refused if the wallet balance is over Binance's cap.

## Part 5: Blitz / Token Race (mint only)

Blitz, also called Token Race, is a 30-second race between BTC, ETH and SOL (the docs still say BNB).
It is **mint only**: you can't sell. After the round settles, the winning outcome's holders split
the pool, and **you have to call `claim` yourself if you won**. Fees: 1.0% protocol, plus the
integrator fee if one is set.

### Finding rounds

```bash
curl -s "https://rest.ft.42.space/api/v1/token-races?limit=100"
# -> roundId, marketAddress, tradingStart, tradingEnd, raceStart, raceEnd, status (not_started|locked|finalised), volume, traders
curl -s "https://rest.ft.42.space/api/v1/markets/<marketAddress>"   # outcomes: tokenId 1=BTC Win, 2=ETH Win, 4=SOL Win
```

- Rounds are scheduled about every 37 seconds. The last round of the day started just before 20:00 UTC,
  even though the docs say 08:00–16:00 UTC. The list runs about 40 minutes ahead.
- **The outcome IDs are 1, 2 and 4, not 0, 1, 2.** Lens `simulateMint` will happily quote IDs 0 and 3, which
  don't exist, so always take the IDs from the REST API.
- REST `status` can still say `not_started` while trading is open, so go by the timestamps.

### The trading window is exactly `[tradingStart, tradingEnd)`, which is 10 seconds

Simulating `Router.swap` locally against a live round showed:

| When | Router.swap result |
|---|---|
| before `tradingStart` | revert `0x774620b8` (not open yet) |
| `tradingStart` +1s … +9s | OK |
| after `tradingEnd` | revert `0x98add4c4` (closed) |

There's no pre-race buying window through this route. During the window, the price is flat at
**0.1 USDT/OT** for the first several seconds, so 1 USDT buys 9.90099 OT after the 1% fee.

### Approve once, outside the window

- Approved **50 USDT** to the Router (gas 29,106).
- Do this ahead of time. There's no room for an approval inside a 10-second window.

### Attempt 1: failed safely, nothing sent

- The script started previewing about 38s before the window and slept 0.8s between attempts.
  Every Binance preview returned `351805 Transaction simulation failed: execution reverted`, **including the
  three that landed inside the window** (t+1s, +4s, +7s).
- The clean-preview gate stopped it from sending anything.

### Attempt 2: success

The script waited until `tradingStart`, then immediately quoted, built and previewed:

| Step | Time |
|---|---|
| window opens | t = 0 |
| Lens quote | +0.4s |
| `baw contract-call preview` | 2.5s → clean |
| `baw contract-call execute` | 2.2s → BROADCASTED |
| receipt | +1.4s → mined (gas 227,538) |
| **total** | **~6.5s, inside the 10-second window** |

- Minted **BTC Win** (picked at random).
  1 USDT → 9.90099 OT.
- Result: **ETH Win** (`resolvedAnswer: 2`). We lost 1 USDT, and there was nothing to claim.
- The REST API showed `finalised` about 16s after `raceEnd`.

### Settlement and claim

- **Lens `getUserState` reverts with `Panic(0x32)` (array index out of bounds) on Blitz markets once the race
  has ended, both while settling and after finalisation.** It worked before the race ended. So
  settlement has to be detected through REST (`/markets/<addr>` → `status: finalised`, `resolvedAnswer`),
  and the holding read with `market.balanceOf(wallet, tokenId)`.
- Claiming would be `market.claim(wallet, [winningTokenId], [balance])` through preview and execute,
  with `to` = the market address. **We haven't tested claiming yet** because we haven't won a round.

### Attempt 3: buy every outcome, then claim ✅

Goal: hold every outcome so that one of them is guaranteed to win, which lets us test `claim`. All three buys were
prepared before the window, the three previews ran at the same time when it opened, then the executes ran at the same time.

| Time (from window open) | Event |
|---|---|
| t = 0 | window opens |
| +2.3s | 3 previews, all clean (in parallel, about 2.3s) |
| +4.6s | BTC execute → BROADCASTED; **ETH and SOL → `351716` "A transaction to the same address on this network is already in progress"** |
| +6.7s | ETH and SOL re-previewed, clean |
| +8.9s | ETH execute → BROADCASTED; SOL → `351716` again |
| +13.0s | SOL execute → `953401 simulation error` (window closed at +10s) → **SOL missed** |
| +42s | REST `finalised`, winner **BTC Win**, about 12s after `raceEnd` |
| +44.8s | claim preview clean: `ContractInteraction`, USDT +2.4171 |
| +48.9s | claim receipt: success, gas 93,122 |

- Minted BTC Win and ETH Win.
- **Claim:** using
  `market.claim(wallet, [1], [9.90099e18])` with `to` = the market. This paid **2.4171 USDT** for 9.90 winning OT.
- Round net: 98.7638 → 99.1809 USDT (**+0.4171**: 2 USDT staked, 2.4171 claimed).

### Blitz findings

1. **Timing is the main risk.** `baw` preview (about 2–2.5s) plus execute (about 2.2s) uses roughly half
   the 10-second window. Build the calldata ahead of time, start previewing exactly at `tradingStart`, and don't retry with sleeps.
2. **Attempt 1's in-window previews reverted on Binance's side, even though local simulation passed.** Binance
   may simulate against slightly stale chain state. Attempt 2 worked, but expect occasional misses.
3. **No human in the loop.** You can't ask the user to confirm inside a 10-second window. The agent
   needs authorization in advance (amount, outcome or rule, and how many rounds) plus an automatic gate:
   simulation OK, no risks, `requireConfirmation: false`, and `to` = Router.
4. **`baw` sends only one transaction at a time per wallet per chain.** A second execute fails with `351716`
   until the first is mined. Previews can run in parallel; executes must be sequential. Each one takes
   about 2.2s plus about 2s until mined, so **at most 2 mints fit in one 10-second Blitz window**, and you can't cover all three outcomes.
5. **Claiming works through `baw`.** Binance labels it `ContractInteraction` and shows the incoming USDT in the preview.
   Settlement was about 12–16s after `raceEnd`. Read it from REST and use `market.balanceOf`, not Lens.
6. **Other wallets use a different contract.** Trades from other users went through
   `0xb300000b72deaeb607a12d5f54773d1c19c7028d` (selector `0x3ecba7f8`). That's probably Binance Wallet's
   front end. Plain `Router.swap` from a regular wallet works too.

## Tooling

The test used throwaway scripts, which have since been replaced by [`scripts/baw-42.ts`](../scripts/baw-42.ts):
`wallet`, `market`, `buy`, `sell`, `claim`, `wait`, `blitz rounds` and `blitz <tokenId|random> <usdt> --yes|--dry-run`.
The step-by-step guide for new users is [`binance-agentic-wallet-tutorial.md`](binance-agentic-wallet-tutorial.md).
