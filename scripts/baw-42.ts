#!/usr/bin/env bun
// 42.space helper for the Binance Agentic Wallet (`baw` CLI).
//
// baw signs; this script never holds a key. It reads 42 state, quotes trades through
// Lens V2 and builds the calldata, then prints the exact `baw contract-call` commands
// to preview and execute. The only command that executes on its own is `blitz`,
// because a Blitz trading window is 10 seconds and there is no time to ask.
//
// Usage: bun scripts/baw-42.ts help

import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { lensV2Abi, marketAbi, routerV2Abi } from "../references/abis.ts";

// === ADDRESSES (BSC Mainnet) ===
const ROUTER: Address = getAddress("0x888888886619275d33c00D3BC62DF94D700DCD42");
const LENS: Address = getAddress("0x4AAd5A856941FB64df10362024e3Ece24023d4d1");
const USDT: Address = getAddress("0x55d398326f99059fF775485246999027B3197955");
const API = "https://rest.ft.42.space/api/v1";
const BINANCE_CHAIN_ID = "56";
const TICK = 10n ** 16n; // 0.01 OT
const DEFAULT_SLIPPAGE_PCT = 5;
const BLITZ_SLIPPAGE_PCT = 10;

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(process.env.BSC_RPC ?? "https://bsc-dataseed.bnbchain.org"),
});

type Tx = { step: string; to: Address; inputData: Hex };
type Outcome = { tokenId: string; name: string };

// === HELPERS ===
const fmt = (v: bigint) => formatUnits(v, 18);
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function smartEps(usdt: number): bigint {
  if (usdt < 5) return 200000000000000000n; // 20% for tiny trades
  if (usdt <= 3000) return 1000000000000000n; // 0.1% normal
  return BigInt(Math.floor((1 / usdt) * 1e18));
}

function encodeDataGuess(guess: bigint, maxIter: bigint, eps: bigint): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [guess, maxIter, eps],
  );
}

function parseSlippage(raw: string | undefined, fallback: number): bigint {
  const pct = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 50) {
    throw new Error("slippage% must be > 0 and < 50 (e.g. 5)");
  }
  return BigInt(Math.round(pct * 100));
}

function addr(raw: string | undefined, what: string): Address {
  if (!raw || !isAddress(raw)) throw new Error(`invalid ${what}: ${raw}`);
  return getAddress(raw);
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function baw(args: string[]): Promise<any> {
  const proc = Bun.spawn(["baw", ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`baw ${args[0]} returned non-JSON output; is the baw CLI installed?`);
  }
}

// The connected Agentic Wallet's BSC address
async function bawWallet(): Promise<Address> {
  const res = await baw(["wallet", "address"]);
  const entry = (res.data?.addresses ?? []).find((a: any) => a.binanceChainId === BINANCE_CHAIN_ID);
  if (!res.success || !entry) {
    throw new Error("could not read the Agentic Wallet address; run `baw wallet status --json` and sign in first");
  }
  return getAddress(entry.address);
}

function previewCommand(wallet: Address, tx: Tx): string {
  return `baw contract-call preview --binanceChainId ${BINANCE_CHAIN_ID} --from ${wallet} --to ${tx.to} --value 0 --inputData ${tx.inputData} --json`;
}

function printTxs(wallet: Address, txs: Tx[]): void {
  console.log("\nTransactions (run in order; wait for each to be mined before previewing the next):");
  txs.forEach((tx, i) => {
    console.log(`\n  ${i + 1}. ${tx.step}`);
    console.log(`     ${previewCommand(wallet, tx)}`);
  });
  console.log(
    "\nFor each one: run the preview, read parsedTx / simulationResult / risks, and only then run\n" +
      "  baw contract-call execute --requestId <requestId> --json\n" +
      "then wait for it to be mined:\n" +
      "  bun scripts/baw-42.ts wait <txHash>",
  );
}

async function marketOutcomes(market: Address): Promise<{ question: string; status: string; resolvedAnswer: string | null; outcomes: Outcome[] }> {
  const m = await getJson(`${API}/markets/${market}`);
  return {
    question: m.question,
    status: m.status,
    resolvedAnswer: m.resolvedAnswer ?? null,
    outcomes: (m.outcomes ?? []).map((o: any) => ({ tokenId: String(o.tokenId), name: o.name })),
  };
}

async function assertOutcome(market: Address, tokenId: bigint): Promise<string> {
  const { outcomes } = await marketOutcomes(market);
  const o = outcomes.find((x) => BigInt(x.tokenId) === tokenId);
  if (!o) {
    throw new Error(
      `tokenId ${tokenId} is not an outcome of this market (valid: ${outcomes.map((x) => `${x.tokenId}=${x.name}`).join(", ")})`,
    );
  }
  return o.name;
}

async function quoteMint(market: Address, tokenId: bigint, amount: bigint, usdt: number) {
  const { result } = await publicClient.simulateContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "simulateMint",
    args: [market, tokenId, amount, true, "0x", encodeDataGuess(0n, 100n, smartEps(usdt)), 0n],
  });
  const [pre, post, quote] = result;
  return { priceBefore: pre.price, priceAfter: post.price, otOut: quote.otToUser, fee: quote.collateralToTreasury };
}

function mintCalldata(market: Address, wallet: Address, tokenId: bigint, amount: bigint, otOut: bigint, minOut: bigint, usdt: number): Hex {
  return encodeFunctionData({
    abi: routerV2Abi,
    functionName: "swap",
    args: [
      market,
      wallet,
      tokenId,
      { isMint: true, amount, isExactIn: true, minOutOrMaxIn: minOut },
      "0x",
      encodeDataGuess(otOut, 50n, smartEps(usdt)),
      zeroAddress,
      0n,
    ],
  });
}

// === COMMANDS ===
async function cmdWallet(): Promise<void> {
  const wallet = await bawWallet();
  const [bnb, usdt, allowance] = await Promise.all([
    publicClient.getBalance({ address: wallet }),
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "allowance", args: [wallet, ROUTER] }),
  ]);
  console.log(`Agentic Wallet (BSC): ${wallet}`);
  console.log(`  BNB (gas):                 ${fmt(bnb)}`);
  console.log(`  USDT:                      ${fmt(usdt)}`);
  console.log(`  USDT approved to Router:   ${fmt(allowance)}`);
  if (bnb === 0n) console.log("  ! No BNB: you need a little BNB on BSC to pay gas.");
}

async function cmdMarket(argv: string[]): Promise<void> {
  const market = addr(argv[0], "market");
  const m = await marketOutcomes(market);
  const prices = await getJson(`${API}/markets/tokens?market_address=${market}`);
  const byId = new Map<string, any>((prices.data ?? []).map((t: any) => [String(t.tokenId), t]));
  console.log(`${m.question}\n  status: ${m.status}${m.resolvedAnswer ? `, resolved: tokenId ${m.resolvedAnswer}` : ""}\n`);
  for (const o of m.outcomes) {
    const t = byId.get(o.tokenId);
    console.log(`  tokenId ${o.tokenId.padEnd(3)} ${o.name.padEnd(28)} price ${t?.price ?? "?"}  marketCap ${t?.marketCap ?? "?"}`);
  }
}

async function cmdBuy(argv: string[]): Promise<void> {
  const market = addr(argv[0], "market");
  const tokenId = BigInt(argv[1] ?? "x");
  const usdtStr = argv[2];
  if (!usdtStr) throw new Error("usage: buy <market> <tokenId> <usdt> [slippage%]");
  const slipBps = parseSlippage(argv[3], DEFAULT_SLIPPAGE_PCT);
  const amount = parseUnits(usdtStr, 18);
  if (amount <= 0n) throw new Error("usdt must be > 0");
  const usdt = Number(usdtStr);

  const wallet = await bawWallet();
  const name = await assertOutcome(market, tokenId);
  const [q, balance, allowance] = await Promise.all([
    quoteMint(market, tokenId, amount, usdt),
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "allowance", args: [wallet, ROUTER] }),
  ]);
  if (balance < amount) throw new Error(`USDT balance ${fmt(balance)} < ${usdtStr}`);
  const minOut = (q.otOut * (10000n - slipBps)) / 10000n;
  const avgPrice = (amount * 10n ** 18n) / q.otOut;

  console.log(`Buy ${name} (tokenId ${tokenId}) with ${usdtStr} USDT`);
  console.log(`  expected:        ${fmt(q.otOut)} OT`);
  console.log(`  minimum (slip):  ${fmt(minOut)} OT  (${Number(slipBps) / 100}% slippage; below this the tx reverts)`);
  console.log(`  price:           ${fmt(q.priceBefore)} -> ${fmt(q.priceAfter)} (your buy moves the curve)`);
  console.log(`  avg paid per OT: ${fmt(avgPrice)} incl. fee`);
  console.log(`  fee:             ${fmt(q.fee)} USDT`);

  const txs: Tx[] = [];
  if (allowance < amount) {
    txs.push({
      step: `approve the 42 Router to spend exactly ${usdtStr} USDT`,
      to: USDT,
      inputData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, amount] }),
    });
  }
  txs.push({
    step: `buy ${name} with ${usdtStr} USDT (min ${fmt(minOut)} OT). Binance labels this "sale"; that is expected`,
    to: ROUTER,
    inputData: mintCalldata(market, wallet, tokenId, amount, q.otOut, minOut, usdt),
  });
  printTxs(wallet, txs);
  if (txs.length > 1) {
    console.log("\nNote: the buy cannot be previewed until the approval is mined. Re-run this command after it is.");
  }
}

async function cmdSell(argv: string[]): Promise<void> {
  const market = addr(argv[0], "market");
  const tokenId = BigInt(argv[1] ?? "x");
  const amountRaw = argv[2] ?? "all";
  const slipBps = parseSlippage(argv[3], DEFAULT_SLIPPAGE_PCT);

  const wallet = await bawWallet();
  const name = await assertOutcome(market, tokenId);
  const [holding, allowance] = await Promise.all([
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "balanceOf", args: [wallet, tokenId] }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "allowance", args: [wallet, ROUTER, tokenId] }),
  ]);
  const wanted = amountRaw === "all" ? holding : parseUnits(amountRaw, 18);
  const amount = (wanted / TICK) * TICK; // OT amounts must be tick-aligned
  if (amount <= 0n) throw new Error(`nothing to sell (holding ${fmt(holding)} OT)`);
  if (amount > holding) throw new Error(`amount ${fmt(amount)} > holding ${fmt(holding)}`);

  const { result } = await publicClient.simulateContract({
    address: LENS,
    abi: lensV2Abi,
    functionName: "simulateRedeem",
    args: [market, tokenId, amount, true, "0x", "0x", 0n],
  });
  const [pre, post, quote] = result;
  const minOut = (quote.collateralToUser * (10000n - slipBps)) / 10000n;
  const marketValue = (amount * pre.price) / 10n ** 18n;

  console.log(`Sell ${fmt(amount)} ${name} (tokenId ${tokenId})`);
  console.log(`  expected:        ${fmt(quote.collateralToUser)} USDT`);
  console.log(`  minimum (slip):  ${fmt(minOut)} USDT  (${Number(slipBps) / 100}% slippage; below this the tx reverts)`);
  console.log(`  amount x price:  ${fmt(marketValue)} USDT; the gap to "expected" is the redeem tax + fee`);
  console.log(`  price:           ${fmt(pre.price)} -> ${fmt(post.price)}`);
  console.log(`  fee:             ${fmt(quote.collateralToTreasury)} USDT`);

  const txs: Tx[] = [];
  if (allowance < amount) {
    txs.push({
      step: `approve the 42 Router to move exactly ${fmt(amount)} ${name} (ERC-6909)`,
      to: market,
      inputData: encodeFunctionData({ abi: marketAbi, functionName: "approve", args: [ROUTER, tokenId, amount] }),
    });
  }
  txs.push({
    step: `sell ${fmt(amount)} ${name} (min ${fmt(minOut)} USDT). Binance labels this "sale"`,
    to: ROUTER,
    inputData: encodeFunctionData({
      abi: routerV2Abi,
      functionName: "swap",
      args: [
        market,
        wallet,
        tokenId,
        { isMint: false, amount, isExactIn: true, minOutOrMaxIn: minOut },
        "0x",
        "0x",
        zeroAddress,
        0n,
      ],
    }),
  });
  printTxs(wallet, txs);
}

async function cmdClaim(argv: string[]): Promise<void> {
  const market = addr(argv[0], "market");
  const wallet = await bawWallet();
  const m = await marketOutcomes(market);
  if (m.status !== "finalised" || m.resolvedAnswer === null) {
    throw new Error(`market is "${m.status}", not finalised yet; claim after it is`);
  }
  const winnerId = BigInt(m.resolvedAnswer);
  const winner = m.outcomes.find((o) => BigInt(o.tokenId) === winnerId)?.name ?? `tokenId ${winnerId}`;
  const holding = await publicClient.readContract({
    address: market,
    abi: marketAbi,
    functionName: "balanceOf",
    args: [wallet, winnerId],
  });
  console.log(`${m.question}\n  winner: ${winner} (tokenId ${winnerId}); you hold ${fmt(holding)}`);
  if (holding === 0n) {
    console.log("  Nothing to claim.");
    return;
  }
  printTxs(wallet, [
    {
      step: `claim ${fmt(holding)} ${winner}. Binance labels this "ContractInteraction" and shows the USDT coming in`,
      to: market,
      inputData: encodeFunctionData({ abi: marketAbi, functionName: "claim", args: [wallet, [winnerId], [holding]] }),
    },
  ]);
}

async function cmdWait(argv: string[]): Promise<void> {
  const hash = argv[0];
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("usage: wait <txHash>");
  const r = await publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 120_000 });
  console.log(`${r.status} | block ${r.blockNumber} | gas ${r.gasUsed} | https://bscscan.com/tx/${hash}`);
  if (r.status !== "success") process.exit(1);
}

// === BLITZ / TOKEN RACE ===
async function upcomingRounds(): Promise<any[]> {
  const res = await getJson(`${API}/token-races?limit=100`);
  return (res.data as any[]).filter((r) => r.tradingStart > now()).sort((a, b) => a.tradingStart - b.tradingStart);
}

async function cmdBlitzRounds(): Promise<void> {
  const rounds = (await upcomingRounds()).slice(0, 5);
  for (const r of rounds) {
    console.log(
      `round ${r.roundId}  ${r.marketAddress}  trading ${new Date(r.tradingStart * 1000).toISOString().slice(11, 19)}-${new Date(r.tradingEnd * 1000).toISOString().slice(11, 19)} UTC (in ${r.tradingStart - now()}s)  ${r.symbols.join(" / ")}`,
    );
  }
}

function cleanPreview(p: any, to: Address): string | null {
  if (!p.success) return `preview error ${p.error?.code}: ${p.error?.message}`;
  const d = p.data;
  if (d.simulationResult?.simulationCode !== "000000000") return `simulation ${d.simulationResult?.simulationCode}`;
  if (d.risks?.riskDetails?.length) return `risks: ${JSON.stringify(d.risks.riskDetails)}`;
  if (Object.keys(d.risks?.addresses ?? {}).length) return `address risks: ${JSON.stringify(d.risks.addresses)}`;
  if (d.requireConfirmation) return "requires confirmation in the Binance App";
  if (d.parsedTx?.contractAddress && getAddress(d.parsedTx.contractAddress) !== to) {
    return `unexpected contract ${d.parsedTx.contractAddress}`;
  }
  return null;
}

// Preview, then execute only if the preview is clean, then wait for the receipt
async function previewExecute(wallet: Address, to: Address, data: Hex, label: string): Promise<Hex | null> {
  const p = await baw(["contract-call", "preview", "--binanceChainId", BINANCE_CHAIN_ID, "--from", wallet, "--to", to, "--value", "0", "--inputData", data]);
  const bad = cleanPreview(p, to);
  if (bad) {
    console.log(`  ${label}: preview not clean (${bad}); not sending`);
    return null;
  }
  const e = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
  if (!e.success || e.data.status !== "BROADCASTED") {
    console.log(`  ${label}: execute failed ${JSON.stringify(e.error ?? e.data)}`);
    return null;
  }
  const r = await publicClient.waitForTransactionReceipt({ hash: e.data.txHash, timeout: 60_000 });
  console.log(`  ${label}: ${r.status} https://bscscan.com/tx/${e.data.txHash}`);
  return r.status === "success" ? (e.data.txHash as Hex) : null;
}

async function cmdBlitz(argv: string[]): Promise<void> {
  if (argv[0] === "rounds") return cmdBlitzRounds();
  const pickRaw = argv[0];
  const usdtStr = argv[1];
  const yes = argv.includes("--yes");
  const dryRun = argv.includes("--dry-run");
  if (!pickRaw || !usdtStr || (!yes && !dryRun)) {
    throw new Error(
      "usage: blitz <tokenId|random> <usdt> --yes | --dry-run\n" +
        "  --yes is required: this command sends the mint (and the claim if you win) without asking,\n" +
        "  because a Blitz trading window is only 10 seconds. --dry-run previews but never sends.",
    );
  }
  const amount = parseUnits(usdtStr, 18);
  const usdt = Number(usdtStr);
  const wallet = await bawWallet();

  const allowance = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "allowance", args: [wallet, ROUTER] });
  if (allowance < amount) {
    throw new Error(
      `Router allowance ${fmt(allowance)} < ${usdtStr} USDT. Approve ahead of time (there is no time inside the window):\n` +
        `  ${previewCommand(wallet, { step: "", to: USDT, inputData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, amount] }) })}`,
    );
  }

  const round = (await upcomingRounds()).find((r) => r.tradingStart - now() >= 8);
  if (!round) throw new Error("no upcoming Blitz round");
  const market = getAddress(round.marketAddress);
  const { outcomes } = await marketOutcomes(market);
  const pick =
    pickRaw === "random"
      ? outcomes[Math.floor(Math.random() * outcomes.length)]
      : outcomes.find((o) => o.tokenId === pickRaw);
  if (!pick) throw new Error(`tokenId ${pickRaw} is not in this round (valid: ${outcomes.map((o) => `${o.tokenId}=${o.name}`).join(", ")})`);
  const tokenId = BigInt(pick.tokenId);

  // Price is flat when the window opens, so the calldata can be built before it
  const q = await quoteMint(market, tokenId, amount, usdt);
  const minOut = (q.otOut * (10000n - BigInt(BLITZ_SLIPPAGE_PCT * 100))) / 10000n;
  const data = mintCalldata(market, wallet, tokenId, amount, q.otOut, minOut, usdt);
  console.log(`Round ${round.roundId} (${market}): ${pick.name}, ${usdtStr} USDT -> ~${fmt(q.otOut)} OT (min ${fmt(minOut)}, ${BLITZ_SLIPPAGE_PCT}% slippage)`);
  console.log(`  window opens in ${round.tradingStart - now()}s and lasts 10s. Mint only: no selling, the stake is locked until settlement.`);

  // Binance simulates against the latest mined block, which can still be stamped before
  // tradingStart for a moment after the window opens, so start one second in
  while (Date.now() < round.tradingStart * 1000 + 1000) await sleep(50);
  if (dryRun) {
    let result = "window closed";
    while (now() < round.tradingEnd - 1) {
      const p = await baw(["contract-call", "preview", "--binanceChainId", BINANCE_CHAIN_ID, "--from", wallet, "--to", ROUTER, "--value", "0", "--inputData", data]);
      const bad = cleanPreview(p, ROUTER);
      console.log(`  dry run: preview ${bad ?? "clean"}`);
      if (!bad) {
        result = "clean";
        break;
      }
    }
    console.log(`  dry run result: ${result}; nothing sent`);
    return;
  }

  let mintTx: Hex | null = null;
  while (!mintTx && now() < round.tradingEnd - 1) {
    mintTx = await previewExecute(wallet, ROUTER, data, "mint");
  }
  if (!mintTx) {
    console.log("  Missed the window; nothing was bought.");
    return;
  }

  // Settlement: Lens getUserState reverts on ended Blitz markets, so use REST + balanceOf
  let m = await marketOutcomes(market);
  while (m.status !== "finalised") {
    await sleep(4000);
    m = await marketOutcomes(market);
  }
  const winnerId = BigInt(m.resolvedAnswer ?? "0");
  const winner = outcomes.find((o) => BigInt(o.tokenId) === winnerId)?.name ?? `tokenId ${winnerId}`;
  console.log(`  Winner: ${winner}.`);
  if (winnerId !== tokenId) {
    console.log(`  You picked ${pick.name}: the ${usdtStr} USDT stake is lost. Nothing to claim.`);
    return;
  }
  const holding = await publicClient.readContract({ address: market, abi: marketAbi, functionName: "balanceOf", args: [wallet, tokenId] });
  const before = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  const claimData = encodeFunctionData({ abi: marketAbi, functionName: "claim", args: [wallet, [tokenId], [holding]] });
  const claimTx = await previewExecute(wallet, market, claimData, "claim");
  if (!claimTx) {
    console.log(`  Claim not sent; run: bun scripts/baw-42.ts claim ${market}`);
    return;
  }
  const after = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  console.log(`  Claimed ${fmt(after - before)} USDT for a ${usdtStr} USDT stake.`);
}

function help(): void {
  console.log(`42.space x Binance Agentic Wallet helper (signing is done by the baw CLI)

Usage:
  bun scripts/baw-42.ts wallet                                  Agentic Wallet address, BNB, USDT, Router allowance
  bun scripts/baw-42.ts market <market>                         outcomes, tokenIds and prices
  bun scripts/baw-42.ts buy <market> <tokenId> <usdt> [slip%]   quote + baw commands to buy (default slippage ${DEFAULT_SLIPPAGE_PCT}%)
  bun scripts/baw-42.ts sell <market> <tokenId> [amount|all] [slip%]
                                                                quote + baw commands to sell
  bun scripts/baw-42.ts claim <market>                          baw command to claim a finalised market
  bun scripts/baw-42.ts wait <txHash>                           wait until a tx is mined
  bun scripts/baw-42.ts blitz rounds                            next Blitz / Token Race rounds
  bun scripts/baw-42.ts blitz <tokenId|random> <usdt> --yes     enter the next Blitz round, claim if it wins (SENDS without asking)
  bun scripts/baw-42.ts blitz <tokenId|random> <usdt> --dry-run preview only, never sends

Environment: BSC_RPC (optional, defaults to https://bsc-dataseed.bnbchain.org)
Tutorial: docs/binance-agentic-wallet-tutorial.md`);
}

// === MAIN ===
const commands: Record<string, (argv: string[]) => Promise<void>> = {
  wallet: () => cmdWallet(),
  market: cmdMarket,
  buy: cmdBuy,
  sell: cmdSell,
  claim: cmdClaim,
  wait: cmdWait,
  blitz: cmdBlitz,
};

const [cmd, ...rest] = process.argv.slice(2);
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  help();
  process.exit(cmd && cmd !== "help" ? 1 : 0);
}
try {
  await run(rest);
} catch (e) {
  console.error(`Error: ${(e as Error).message.split("\n").slice(0, 6).join("\n")}`);
  process.exit(1);
}
