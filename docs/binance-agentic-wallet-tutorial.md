# Trade 42.space with a Binance Agentic Wallet: step-by-step tutorial

This guide takes you from nothing to your first trade on [42.space](https://42.space) using a
**Binance Agentic Wallet**: a keyless wallet that you (or your AI agent) control through the `baw` CLI,
with limits you set in the Binance App. You never handle a private key.

Every step here was run for real on 2026-11-02. The full log, with transaction hashes, is in
[`baw-test-run-2026-11-02.md`](baw-test-run-2026-11-02.md).

> ⚠️ This is real money on BNB Smart Chain. Start with $1–5. Read [Step 7](#step-7-understand-pricing-before-you-trade)
> before your first trade: prices on 42 move with every trade, and selling early costs more than you might expect.

## How it fits together

```
 you / your agent
       │
       ▼
 scripts/baw-42.ts ──reads──▶ 42 REST API + 42 contracts (quotes, positions)
       │ prints
       ▼
 baw contract-call preview ──▶ Binance simulates + risk-checks the tx
 baw contract-call execute ──▶ Binance signs + broadcasts (MPC, no private key)
       │
       ▼
 bun scripts/baw-42.ts wait <txHash>
```

`baw` handles the wallet. It doesn't know 42 exists, so 42 trades go through its
**Developer Mode** (`contract-call`). `scripts/baw-42.ts` does the 42-specific part: finding markets,
quoting, checking approvals and building each transaction. It then prints the `baw` command to run.

## What you need

- The **Binance App** with a Binance Wallet. You'll need to approve sign-in and settings on your phone.
- [Node.js](https://nodejs.org) 18+ (for `baw`) and [Bun](https://bun.sh) 1.3+ (for this repo).
- A few USDT and a little BNB on **BSC** (BNB Smart Chain).

---

## Step 1: Clone this repo

```bash
git clone https://github.com/wenlanbo/wenlanbot.git
cd wenlanbot
bun install
bun scripts/baw-42.ts help
```

## Step 2 (optional): Install the Binance Agentic Wallet skill for your agent

If an AI agent such as Claude Code will be trading for you, give it Binance's skill so it knows the `baw` commands:

```bash
npx skills add binance/binance-skills-hub --skill binance-agentic-wallet -g -a claude-code -y
```

- `-g` installs it for your user, not just this project. `-a claude-code` picks the agent (`'*'` = all agents).
- The installer shows third-party security ratings. At the time of writing they were Gen "Critical Risk",
  Socket "1 alert" and Snyk "Med Risk". That's typical for any skill that can move funds; read
  [the skill](https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet)
  before using it.

## Step 3: Install the `baw` CLI

```bash
npm install -g @binance/agentic-wallet@1.12.0
baw cli-check --required-version 1.12.0 --json     # expect "needUpdateCli": false
baw wallet status --json                            # expect "UNCONNECTED" before you sign in
```

## Step 4: Sign in

```bash
baw auth signin --json
```

This returns a `pairingCode`, a `urlForWeb` and a `qrCodeId`.

1. Open `urlForWeb` in your browser. It shows a QR code.
2. Scan it with the **Binance App** and check that the **pairing code matches** what the CLI printed.
3. Confirm in the App.
4. Then run, and **leave it running** until it returns:

```bash
baw auth verify --qrCodeId <qrCodeId> --json        # blocks until you confirm (5 min timeout)
baw wallet status --json                             # expect "CONNECTED"
```

- If `verify` is killed early, the login may not be saved locally even though the App says it worked.
  Run `baw auth signin` again for a fresh code; old codes expire after about 5 minutes.
- A session lasts **48 hours**, and you're also signed out after 48 hours without use. The longest a
  session can last is 7 days. **Sign-out is silent**: commands just start failing. `baw wallet settings --json`
  shows `sessionExpireTime`.

## Step 5: Turn on Developer Mode (required for 42)

42 trades are custom contract calls, which the Agentic Wallet only allows in Developer Mode.

In the **Binance App**: Agentic Wallet management page → **Settings** (top-right icon) → turn on
**Developer Mode** → read and accept the Risk Warning → approve the signature request.

Check it:

```bash
baw wallet settings --json
# "devMode": { "enabled": true, "expiresAt": "...", "dailyLimit": 1000, "balanceExceeded": false }
```

| Limit | What it means |
|---|---|
| 7 days | Developer Mode switches itself off after 7 days. Each trade extends it. |
| `devMode.dailyLimit` (1,000) | Daily cap on the value of contract calls. Our test trades counted about $1 each. |
| Balance cap | Developer Mode is **refused (`351804`) if the wallet holds more than Binance's cap**. Keep the trading wallet small. |

## Step 6: Fund the wallet

```bash
bun scripts/baw-42.ts wallet
```

This prints your Agentic Wallet's BSC address (the same address on every EVM chain) and its balances.

Send to that address **on BNB Smart Chain (BEP-20)**:

- **USDT**: `0x55d398326f99059fF775485246999027B3197955`. This is what you trade with on 42. It has 18 decimals on BSC.
- **A little BNB** for gas. 0.01 BNB covers hundreds of trades; a whole buy-then-sell cost us about 0.00005 BNB.

When withdrawing from Binance, pick the **BSC / BEP-20** network. Funds sent on another chain arrive
at the same address but can't be used on 42.

> `baw wallet balance` may not list your USDT, even when it's there. Our 100 USDT never showed up in it.
> Use `bun scripts/baw-42.ts wallet`, which reads the balance straight from the chain.

---

## Step 7: Understand pricing before you trade

42 isn't an order book and it isn't a simple "yes = $0.62" market. Read this once.

### The price curve

- Each outcome has its own **bonding curve**. You buy from and sell to a smart contract, not to another person.
- **Every buy pushes that outcome's price up; every sell pushes it down.** The bigger your trade relative
  to the market, the more you move the price. A quote shows `price: before -> after` for that reason.
- **Price is not probability.** A price of 0.03 doesn't mean a 3% chance. Compare prices across outcomes
  for relative confidence, and look at the pool size.
- At resolution, **the whole pool goes to holders of the winning outcome**, shared out by how many tokens
  each holds (`your tokens ÷ all winning tokens × pool`). Losing outcomes pay nothing.

### Slippage: your safety floor

Between your quote and your transaction being mined, other people can trade and move the price. Every
trade built by `scripts/baw-42.ts` includes a **minimum amount out**:

- buy: "give me at least N outcome tokens for my USDT"
- sell: "give me at least N USDT for my tokens"

If the price moved more than your **slippage tolerance**, the transaction **reverts** instead of filling at
a worse price. You lose only the gas.

| Setting | When |
|---|---|
| **5%** (default for `buy`/`sell`) | Normal markets |
| 1–2% | Large trades in calm markets, if you'd rather fail than fill at a worse price |
| **10%** (used by `blitz`) | Blitz races, where prices move every second once the race starts |

Pass a different tolerance as the last argument, e.g. `buy <market> <tokenId> 5 2` for 2%. Don't raise it
just to force a trade through: a higher tolerance only means you accept a worse price.

### Selling early costs more than the fee: the redeem tax

When you sell before the market resolves, 42 takes a **redeem tax** (a variable spread) as well as the fee.
It's larger when your sale is a big share of that outcome's supply, when the outcome has little supply,
and as the market gets close to resolution. The tax stays in the pool.

**Real example from our test:** we bought 31.51 tokens for **1.00 USDT** and sold them straight back for
**0.7637 USDT**, a **24% round-trip loss**, although the listed fee is only about 0.4%.

So: **buy what you're willing to hold until resolution.** "I can always sell" is true, but not at the price
you paid. The `sell` quote prints `amount x price` next to the real `expected` amount so you can see the gap
before you commit.

### Fees

- Regular markets: about 0.4% protocol fee on the trade (shown as `fee` in each quote).
- Blitz: 1.0% protocol fee (plus an integrator fee in apps that charge one).

---

## Step 8: Your first buy

### 8.1 Find a market

```bash
curl -s "https://rest.ft.42.space/api/v1/markets?status=live&order=volume&limit=10" \
  | jq -r '.data[] | "\(.address)  \(.question)"'

bun scripts/baw-42.ts market <marketAddress>
```

`market` lists each outcome's **tokenId**, name and price. Outcome IDs aren't always 0, 1, 2…
(we saw 1, 2 and 4), so always copy them from this list.

### 8.2 Get a quote and the transactions

```bash
bun scripts/baw-42.ts buy <marketAddress> <tokenId> 1          # 1 USDT, 5% slippage
```

Example output:

```
Buy BNB (tokenId 2) with 1 USDT
  expected:        31.51 OT
  minimum (slip):  29.9345 OT  (5% slippage; below this the tx reverts)
  price:           0.03141667 -> 0.03141730 (your buy moves the curve)
  fee:             0.0099 USDT

Transactions (run in order; wait for each to be mined before previewing the next):
  1. approve the 42 Router to spend exactly 1 USDT
     baw contract-call preview --binanceChainId 56 --from 0x... --to 0x55d3...7955 --value 0 --inputData 0x095ea7b3... --json
  2. buy BNB with 1 USDT (min 29.9345 OT)
     baw contract-call preview --binanceChainId 56 --from 0x... --to 0x8888...DCD42 --value 0 --inputData 0xc42e5b2a... --json
```

The approval only appears when needed. The script approves **exactly** the trade amount, not unlimited.

### 8.3 Preview → read → execute → wait, for each transaction

```bash
# 1. preview (nothing is sent)
baw contract-call preview ... --json
```

Read the preview before going on:

| Field | What to check |
|---|---|
| `success` | `true`. If not, stop. |
| `parsedTx.transactionType` | `Approve` for approvals. 42 buys and sells show as **`"sale"`**; Binance doesn't understand 42's calls, so that label is expected. |
| `simulationResult.allowanceChanges` | Approvals: the spender is the 42 Router `0x888888886619275d33c00D3BC62DF94D700DCD42` and the amount is what you expect. |
| `simulationResult.balanceChanges` | The USDT leaving (buy) or arriving (sell/claim). Outcome tokens **aren't shown**; rely on the quote. |
| `risks.riskDetails`, `risks.addresses` | Should be empty. If not, read them and think twice. |
| `requireConfirmation` | `false` = sends straight away. `true` = you'll need to approve it in the Binance App. |

```bash
# 2. execute: signs and broadcasts, returns a txHash immediately
baw contract-call execute --requestId <requestId from the preview> --json

# 3. wait until it's mined
bun scripts/baw-42.ts wait <txHash>
```

**Then go to the next transaction.** The buy can't be previewed until the approval is mined, because
Binance's simulation needs the approval to already exist. If a preview expires, preview again.

## Step 9: Sell

```bash
bun scripts/baw-42.ts sell <marketAddress> <tokenId>            # sell everything
bun scripts/baw-42.ts sell <marketAddress> <tokenId> 10 3       # sell 10 tokens, 3% slippage
```

The first sell of an outcome needs an extra approval for the outcome token (an ERC-6909 `approve` on the market
contract). Then preview → execute → wait, exactly as in Step 8.3. Remember the [redeem tax](#selling-early-costs-more-than-the-fee-the-redeem-tax).

## Step 10: Claim after the market resolves

```bash
bun scripts/baw-42.ts claim <marketAddress>
```

- If the market isn't `finalised` yet, it tells you to wait.
- If you hold the winning outcome, it prints the claim transaction (`market.claim`). Preview → execute → wait.
  Binance labels it `ContractInteraction` and shows the USDT you'll receive.
- Claiming is **one transaction per market**. The batch-claim route in `trade.ts` (`bebe-claim`) uses EIP-7702,
  which the Agentic Wallet can't sign.

> We tested claiming on a **Blitz** round. Regular event-market claims use the same `market.claim` call
> but haven't been tested with an Agentic Wallet yet.

---

## Step 11 (advanced): Blitz / Token Race

[Blitz](https://docs.42.space/getting-started/publish-your-docs/blitz.md) is a 30-second race between
BTC, ETH and SOL. You back one, and that round's whole pool goes to the winner's holders.

- **Mint only.** You can't sell; your stake is locked until the round settles.
- **10-second trading window** (`tradingStart` → `tradingEnd`). Outside it the Router reverts.
- Rounds run every ~37 seconds during the day. On our test day the last one started just before 20:00 UTC;
  `blitz rounds` shows what's scheduled.
- The price is flat (0.1) when the window opens and moves once the race starts.
- **You have to claim if you win.**

There's no time to preview and confirm by hand inside a 10-second window, so the `blitz` command does it
for you: it builds the trade before the window, previews when it opens, and **sends only if the preview
is clean** (simulation OK, no risks, no App confirmation needed). Then it waits for settlement and claims
if you won.

```bash
bun scripts/baw-42.ts blitz rounds                        # upcoming rounds
bun scripts/baw-42.ts blitz random 1 --dry-run            # rehearse: preview in the real window, send nothing

# approve USDT for the Router ahead of time: there's no room for an approval inside the window.
#   `approve` sets the allowance to exactly this total (it replaces, not adds), e.g. 5 USDT = five 1-USDT rounds.
#   Then preview -> execute -> wait as in Step 8.3. If the allowance runs out, `blitz` stops before the round.
bun scripts/baw-42.ts approve 5
bun scripts/baw-42.ts blitz 1 1 --yes                     # 1 USDT on tokenId 1 (BTC Win) in the next round
bun scripts/baw-42.ts blitz random 1 --yes                # random outcome
```

Things we learned:

- Preview plus execute takes about 4–5 seconds, about half the window. A round can be missed. If so, nothing is sent.
- The Agentic Wallet sends **one transaction at a time** per wallet per chain (error `351716`), so you can't
  cover all three outcomes in one round. In our test, two fitted.
- Rounds settle about 12–16 seconds after the race ends.

---

## Troubleshooting

| Error / symptom | Meaning | Fix |
|---|---|---|
| `wallet status` → `UNCONNECTED` | Session expired or signed out | Step 4 again |
| `351802` | Developer Mode expired | Turn it on again in the App (Step 5) |
| `351804` | Wallet balance above the Developer Mode cap | Move funds out, keep the trading wallet small |
| `351805 … token spending limit is either not approved or expired` | No USDT approval for the Router | Run the approval transaction first |
| `351805 … execution reverted` | The trade would fail on-chain: market closed or not open, slippage exceeded, Blitz window not open yet | Re-quote; check the market status and times |
| `351716 … already in progress` | A transaction from this wallet hasn't been mined yet | Wait for it, then retry |
| `351803 AGENT_DEV_MODE_RISK_BLOCKED` | Binance's risk engine blocked it | Don't force it; read the risk details |
| `USDT balance … <` but you funded it | Wrong network, or still in transit | Check you sent on BSC (BEP-20) |
| `tokenId X is not an outcome` | Wrong ID | Use `bun scripts/baw-42.ts market <market>` |

## Safety checklist

- Keep only what you're prepared to lose in the trading wallet. Developer Mode requires a small balance anyway.
- Approve exact amounts. `baw approvals list --json` shows what's approved; `bun scripts/baw-42.ts approve 0` revokes the Router's USDT allowance.
- Always read the preview before `execute`, especially `risks` and `allowanceChanges`.
- Never paste session tokens or wallet secrets into chats or issues. The `baw` CLI never needs them in commands.
- Do your own research. Nothing here is investment advice.
