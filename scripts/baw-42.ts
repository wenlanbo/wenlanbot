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
  let proc;
  try {
    proc = Bun.spawn(["baw", ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("could not run `baw`; install it with: npm install -g @binance/agentic-wallet@1.12.0");
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // baw reports most failures as {"success":false,...} JSON, so parse stdout first
  try {
    return JSON.parse(out);
  } catch {
    const detail = (err.trim() || out.trim() || "no output").split("\n").slice(0, 3).join(" | ");
    throw new Error(`baw ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${detail}`);
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

// Sets the Router's USDT allowance to exactly <usdt> (it replaces the current allowance, it does not add)
async function cmdApprove(argv: string[]): Promise<void> {
  const usdtStr = argv[0];
  if (!usdtStr) throw new Error("usage: approve <usdt>   (use 0 to revoke)");
  const amount = parseUnits(usdtStr, 18);
  if (amount < 0n) throw new Error("usdt must be >= 0");
  const wallet = await bawWallet();
  const current = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "allowance", args: [wallet, ROUTER] });
  console.log(`USDT allowance for the 42 Router: ${fmt(current)} -> ${usdtStr} (this replaces the current allowance)`);
  printTxs(wallet, [
    {
      step: amount === 0n ? "revoke the 42 Router's USDT allowance" : `approve the 42 Router to spend up to ${usdtStr} USDT in total`,
      to: USDT,
      inputData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, amount] }),
    },
  ]);
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

// What the simulated transaction may do to the wallet's USDT: a mint may spend at most
// `maxUsdtOut`; a claim (maxUsdtOut = 0) must not spend any.
type PreviewExpectation = { wallet: Address; to: Address; maxUsdtOut: bigint };

// Binance's preview does not echo the calldata back, so the auto-execute gate binds the
// preview to our intent through what it can check: target contract, simulated balance
// changes, and the shape of the ids it returns. Anything missing or unexpected fails closed.
function cleanPreview(p: any, expect: PreviewExpectation): string | null {
  if (p?.success !== true) return `preview error ${p?.error?.code}: ${p?.error?.message}`;
  const d = p.data;
  if (typeof d?.requestId !== "string" || !/^[0-9a-zA-Z_-]{8,128}$/.test(d.requestId)) return "missing or malformed requestId";
  if (d.simulationResult?.simulationCode !== "000000000") return `simulation ${d.simulationResult?.simulationCode}`;
  if (d.risks?.riskDetails?.length) return `risks: ${JSON.stringify(d.risks.riskDetails)}`;
  if (Object.keys(d.risks?.addresses ?? {}).length) return `address risks: ${JSON.stringify(d.risks.addresses)}`;
  if (d.requireConfirmation !== false) return "requires confirmation in the Binance App";
  const target = d.parsedTx?.contractAddress;
  if (typeof target !== "string" || !isAddress(target) || getAddress(target) !== expect.to) {
    return `preview targets ${target ?? "no contract"}, expected ${expect.to}`;
  }

  // Simulated balance changes are JSON numbers (lossy above 2^53), so compare with a 0.01% margin
  for (const c of d.simulationResult?.balanceChanges ?? []) {
    if (typeof c?.owner !== "string" || c.owner.toLowerCase() !== expect.wallet.toLowerCase()) continue;
    const change = Number(c.change);
    if (!Number.isFinite(change)) return `unreadable balance change ${JSON.stringify(c)}`;
    const isUsdt = typeof c.contractAddress === "string" && c.contractAddress.toLowerCase() === USDT.toLowerCase();
    if (!isUsdt) {
      if (change < 0) return `simulation spends a token other than USDT: ${JSON.stringify(c)}`;
      continue;
    }
    if (change < 0 && -change > Number(expect.maxUsdtOut) * 1.0001) {
      return `simulation spends ${-change / 1e18} USDT, more than the ${fmt(expect.maxUsdtOut)} expected`;
    }
  }
  for (const a of d.simulationResult?.allowanceChanges ?? []) {
    if (Number(a?.postAmount) > Number(a?.preAmount)) return `simulation raises an allowance: ${JSON.stringify(a)}`;
  }
  if (d.simulationResult?.authorityChanges?.length) return `simulation changes wallet authority: ${JSON.stringify(d.simulationResult.authorityChanges)}`;
  return null;
}

// "not-sent": nothing was broadcast, safe to retry. Once broadcast, never retry: the tx may still land.
type SendResult =
  | { sent: false }
  | { sent: true; hash: Hex; status: "success" | "reverted" | "unconfirmed" };

// Preview, execute only if the preview is clean, then wait for the receipt
async function previewExecute(data: Hex, expect: PreviewExpectation, label: string): Promise<SendResult> {
  let p;
  try {
    p = await baw(["contract-call", "preview", "--binanceChainId", BINANCE_CHAIN_ID, "--from", expect.wallet, "--to", expect.to, "--value", "0", "--inputData", data]);
  } catch (err) {
    console.log(`  ${label}: preview failed (${(err as Error).message}); not sending`);
    return { sent: false };
  }
  const bad = cleanPreview(p, expect);
  if (bad) {
    console.log(`  ${label}: preview not clean (${bad}); not sending`);
    return { sent: false };
  }

  let e;
  try {
    e = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
  } catch (err) {
    // The CLI died mid-execute: we can't tell whether it broadcast, so stop rather than retry
    console.log(`  ${label}: execute failed (${(err as Error).message}). Check \`baw wallet tx-history --json\` before trying again.`);
    return { sent: true, hash: "0x" as Hex, status: "unconfirmed" };
  }
  if (e?.success !== true || e.data?.status !== "BROADCASTED") {
    if (e?.data?.status === "PENDING_CONFIRMATION") {
      console.log(`  ${label}: waiting for confirmation in the Binance App (order ${e.data.orderId}); not retrying`);
      return { sent: true, hash: "0x" as Hex, status: "unconfirmed" };
    }
    console.log(`  ${label}: execute failed ${JSON.stringify(e?.error ?? e?.data)}`);
    return { sent: false };
  }
  const hash = e.data.txHash;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    console.log(`  ${label}: broadcast reported a malformed txHash ${JSON.stringify(hash)}; not retrying`);
    return { sent: true, hash: "0x" as Hex, status: "unconfirmed" };
  }
  try {
    const r = await publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 120_000 });
    console.log(`  ${label}: ${r.status} https://bscscan.com/tx/${hash}`);
    return { sent: true, hash: hash as Hex, status: r.status };
  } catch {
    console.log(`  ${label}: broadcast but not confirmed within 120s: https://bscscan.com/tx/${hash}`);
    return { sent: true, hash: hash as Hex, status: "unconfirmed" };
  }
}

// REST read that survives transient failures; returns null if it keeps failing
async function marketOutcomesRetry(market: Address) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await marketOutcomes(market);
    } catch (err) {
      console.log(`  (42 API error: ${(err as Error).message}; retrying)`);
      await sleep(2000);
    }
  }
  return null;
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
        `  bun scripts/baw-42.ts approve <usdt>     e.g. approve ${usdtStr} for one round, or more for several`,
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
  const mintExpect: PreviewExpectation = { wallet, to: ROUTER, maxUsdtOut: amount };
  if (dryRun) {
    let result = "window closed";
    while (now() < round.tradingEnd - 1) {
      let bad: string | null;
      try {
        const p = await baw(["contract-call", "preview", "--binanceChainId", BINANCE_CHAIN_ID, "--from", wallet, "--to", ROUTER, "--value", "0", "--inputData", data]);
        bad = cleanPreview(p, mintExpect);
      } catch (err) {
        bad = (err as Error).message;
      }
      console.log(`  dry run: preview ${bad ?? "clean"}`);
      if (!bad) {
        result = "clean";
        break;
      }
    }
    console.log(`  dry run result: ${result}; nothing sent`);
    return;
  }

  // Retry only while nothing has been broadcast, so a slow receipt never causes a second mint
  let mint: SendResult = { sent: false };
  while (!mint.sent && now() < round.tradingEnd - 1) {
    mint = await previewExecute(data, mintExpect, "mint");
  }
  if (!mint.sent) {
    console.log("  Missed the window; nothing was bought.");
    return;
  }
  if (mint.status === "reverted") {
    console.log("  The mint reverted on-chain (only gas was spent); nothing was bought.");
    return;
  }

  // From here the stake may be locked, so every exit says how to claim later
  const recovery = `When the round is finalised, check and claim with: bun scripts/baw-42.ts claim ${market}`;

  // Settlement: Lens getUserState reverts on ended Blitz markets, so use REST + balanceOf.
  // Rounds settled about 15s after raceEnd in testing; give up after 5 minutes.
  const deadline = round.raceEnd + 300;
  let m = await marketOutcomesRetry(market);
  while (m?.status !== "finalised" && now() < deadline) {
    await sleep(4000);
    m = (await marketOutcomesRetry(market)) ?? m;
  }
  if (!m || m.status !== "finalised" || m.resolvedAnswer === null) {
    console.log(`  Round not finalised after 5 minutes (status: ${m?.status ?? "unknown"}).\n  ${recovery}`);
    return;
  }
  const winnerId = BigInt(m.resolvedAnswer);
  const winner = outcomes.find((o) => BigInt(o.tokenId) === winnerId)?.name ?? `tokenId ${winnerId}`;
  console.log(`  Winner: ${winner}.`);
  if (winnerId !== tokenId) {
    console.log(`  You picked ${pick.name}: the ${usdtStr} USDT stake is lost. Nothing to claim.`);
    return;
  }

  try {
    const holding = await publicClient.readContract({ address: market, abi: marketAbi, functionName: "balanceOf", args: [wallet, tokenId] });
    if (holding === 0n) {
      console.log(`  You hold no ${pick.name}: the mint did not land (${mint.hash}). Nothing to claim.`);
      return;
    }
    const before = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
    const claimData = encodeFunctionData({ abi: marketAbi, functionName: "claim", args: [wallet, [tokenId], [holding]] });
    const claim = await previewExecute(claimData, { wallet, to: market, maxUsdtOut: 0n }, "claim");
    if (!claim.sent || claim.status !== "success") {
      console.log(`  Claim not completed. ${recovery}`);
      return;
    }
    const after = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
    console.log(`  Claimed ${fmt(after - before)} USDT for a ${usdtStr} USDT stake.`);
  } catch (err) {
    console.log(`  Error while claiming: ${(err as Error).message}\n  ${recovery}`);
  }
}

function help(): void {
  console.log(`42.space x Binance Agentic Wallet helper (signing is done by the baw CLI)

Usage:
  bun scripts/baw-42.ts wallet                                  Agentic Wallet address, BNB, USDT, Router allowance
  bun scripts/baw-42.ts approve <usdt>                          set the Router's USDT allowance to exactly <usdt> (0 = revoke)
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
  approve: cmdApprove,
  market: cmdMarket,
  buy: cmdBuy,
  sell: cmdSell,
  claim: cmdClaim,
  wait: cmdWait,
  blitz: cmdBlitz,
};

async function main(): Promise<void> {
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
}

if (import.meta.main) await main();

export { cleanPreview, type PreviewExpectation };
