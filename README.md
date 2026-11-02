# 42.space Trading Skill

A complete, agent-agnostic guide for AI agents to trade prediction markets on [42.space](https://42.space) (BNB Smart Chain).

## What's Included

- **docs/binance-agentic-wallet-tutorial.md** — Step-by-step setup: Binance Agentic Wallet → first trade on 42 (start here if you're new)
- **scripts/baw-42.ts** — 42 helper for the Binance Agentic Wallet (`baw` CLI): quotes, buy/sell/claim transactions, Blitz rounds
- **SKILL.md** — Full trading guide: market mechanics, REST API, on-chain trading, optional 0x and Privy integrations
- **references/** — Complete smart contract ABIs (Router, Factory, Curve)
- **scripts/trade.ts** — CLI trading tool for a raw private-key wallet (TypeScript/Bun)

## Two ways to trade

| | **A. Binance Agentic Wallet** (recommended for new users) | **B. Private key** |
|---|---|---|
| Wallet | Keyless MPC wallet in the Binance App, driven by the `baw` CLI | Your own BSC key in `.env` |
| Limits | Daily limits + risk checks set in the Binance App | None beyond your balance |
| Signing | Each tx is previewed (simulated + risk-checked) by Binance, then executed | `trade.ts` signs directly |
| Tool | `scripts/baw-42.ts` | `scripts/trade.ts` |
| Not supported | `bebe-claim` / `undelegate` (EIP-7702) | — |

### Before your first trade: price curve and slippage

- **Prices move with every trade.** Each outcome is priced by a bonding curve: buying pushes its price up, selling pushes it down. Price is **not** probability.
- **Slippage is your safety floor.** Every trade carries a minimum amount out (default 5%, 10% for Blitz). If the price moves further before your tx is mined, it reverts instead of filling at a worse price.
- **Selling early costs more than the fee.** Sells before resolution pay a dynamic *redeem tax*. In our test, buying for 1 USDT and selling straight back returned 0.76 USDT (−24%). Buy what you're willing to hold until resolution.

Details in [Step 7 of the tutorial](docs/binance-agentic-wallet-tutorial.md#step-7-understand-pricing-before-you-trade).

## Prerequisites

- **[Bun](https://bun.sh)** — primary runtime. `curl -fsSL https://bun.sh/install | bash`
- **B-USDT (BEP-20, 18 decimals)** for trade collateral and a little **BNB** for gas, on BSC.
- Option A also needs the **Binance App** and **Node.js 18+** (for the `baw` CLI).
- Optional: a private BSC RPC (`BSC_RPC`). The default (`https://bsc-dataseed.bnbchain.org`) works for light use but is rate-limited.

## Install

```bash
git clone https://github.com/wenlanbo/wenlanbot.git
cd wenlanbot
bun install
```

## Option A: Binance Agentic Wallet

Follow **[docs/binance-agentic-wallet-tutorial.md](docs/binance-agentic-wallet-tutorial.md)**. In short:

```bash
npm install -g @binance/agentic-wallet@1.12.0       # the baw CLI
baw auth signin --json                               # scan the QR in the Binance App, then:
baw auth verify --qrCodeId <qrCodeId> --json
# Binance App → Agentic Wallet → Settings → turn on Developer Mode
bun scripts/baw-42.ts wallet                         # your BSC address + balances; fund it with USDT + BNB on BSC

bun scripts/baw-42.ts market 0xMARKET                # outcomes + tokenIds
bun scripts/baw-42.ts buy 0xMARKET <tokenId> 1       # quote + the baw commands to run
baw contract-call preview ... --json                 # read it, then:
baw contract-call execute --requestId <id> --json
bun scripts/baw-42.ts wait <txHash>
```

Also: `sell`, `claim`, `blitz rounds`, `blitz <tokenId|random> <usdt> --dry-run|--yes`. See `bun scripts/baw-42.ts help`.

## Option B: Private key (`scripts/trade.ts`)

Copy the example env and fill in your key:

```bash
cp .env.example .env
# edit .env — BSC_PRIVATE_KEY is required
```

> For running `scripts/trade.ts` / `scripts/monitor.js` under Node, pass the flag: `node --env-file=.env scripts/trade.ts status`.

### Env vars

| Variable | Required | Notes |
|---|---|---|
| `BSC_PRIVATE_KEY` | yes | `0x` + 64 hex. Wallet address is derived automatically. |
| `BSC_RPC` | no | Defaults to `https://bsc-dataseed.bnbchain.org`. |
| `INTEGRATOR_ADDRESS` | no | Integrator wallet to receive trade fees. Optional. |
| `INTEGRATOR_FEE_BPS` | no | Integrator fee in basis points (100 bps = 1%). Defaults to `0`. Any value > 0 requires `INTEGRATOR_ADDRESS` to be set. |
| `BSC_WALLET_ADDRESS` | only for `monitor.js` | `trade.ts` derives this from `BSC_PRIVATE_KEY`. |
| `SLACK_WEBHOOK`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MONITOR_*` | optional | See `SKILL.md` §7 for the full list. |

### Usage

```bash
# Help
bun scripts/trade.ts help

# Check wallet status
bun scripts/trade.ts

# Get market info
bun scripts/trade.ts info 0xMARKET_ADDRESS

# Trade
bun scripts/trade.ts buy 0xMARKET_ADDRESS 1 10 [slippage%] # tokenId=1, 10 USDT
bun scripts/trade.ts sell 0xMARKET_ADDRESS 1 100 [slippage%] # tokenId=1, 100 OT
```

`bun run trade <cmd>` shortcuts the same thing via `package.json`.

### Faster cold start (optional)

Build and run a tree-shaken bundle to avoid traversing module graph.

```bash
bun run build
bun dist/trade.js help
```

For a zero-dependency distributable (no Bun required on the target machine):

```bash
bun build --compile --minify --target=bun --outfile bin/trade scripts/trade.ts
./bin/trade help
```

## For AI Agents

Read `SKILL.md` — it contains everything needed to:
1. Discover and analyze markets via REST API
2. Execute trades on-chain (buy, sell, claim)
3. Optionally use 0x for token swaps and Privy for managed wallets

If the user's wallet is a Binance Agentic Wallet, follow `docs/binance-agentic-wallet-tutorial.md` and use `scripts/baw-42.ts` to build transactions: always run `baw contract-call preview`, show the user the result, and get explicit confirmation before `execute`.

## License

MIT
