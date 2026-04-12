# 42.space Trading Skill

A complete, agent-agnostic guide for AI agents to trade prediction markets on [42.space](https://42.space) (BNB Smart Chain).

## What's Included

- **SKILL.md** — Full trading guide: market mechanics, REST API, on-chain trading, optional 0x and Privy integrations
- **references/** — Complete smart contract ABIs (Router, Factory, Curve)
- **scripts/trade.js** — Ready-to-use CLI trading tool

## Quick Start

```bash
# Install dependencies
npm install ethers

# Set environment variables
export BSC_PRIVATE_KEY="your_private_key"
export BSC_WALLET_ADDRESS="your_wallet_address"

# Check wallet status
node scripts/trade.js

# Get market info
node scripts/trade.js info 0xMARKET_ADDRESS

# Buy outcome tokens
node scripts/trade.js buy 0xMARKET_ADDRESS 1 10  # tokenId=1, 10 USDT
```

## For AI Agents

Read `SKILL.md` — it contains everything needed to:
1. Discover and analyze markets via REST API
2. Execute trades on-chain (buy, sell, claim)
3. Optionally use 0x for token swaps and Privy for managed wallets

## License

MIT
