import { ethers } from "ethers";
import ROUTER_ABI  from "../references/router-abi.json"  with { type: "json" };
import FACTORY_ABI from "../references/factory-abi.json" with { type: "json" };
import CURVE_ABI   from "../references/curve-abi.json"   with { type: "json" };
import LENS_ABI    from "../references/lens-abi.json"    with { type: "json" };

// === CONFIG ===
const RPC = process.env.BSC_RPC || "https://bsc-dataseed1.binance.org";
const PRIVATE_KEY = process.env.BSC_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("ERROR: Set BSC_PRIVATE_KEY env var"); process.exit(1); }
// Derive wallet address from the private key — no separate env var needed.
const WALLET = new ethers.Wallet(PRIVATE_KEY).address;

// Contract addresses (BSC Mainnet Production)
const ROUTER_ADDR = "0x88888888338e60bfB4657187169cFFa5c8640E42";
const CURVE_ADDR  = "0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da";
const LENS_ADDR   = "0x9a9846037238599b10f60a59C2607a8c3159E827";
const USDT_ADDR   = "0x55d398326f99059fF775485246999027B3197955";
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
];
const ERC6909_ABI = [
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function allowance(address owner, address spender, uint256 id) view returns (uint256)",
  "function approve(address spender, uint256 id, uint256 amount) returns (bool)",
  "function isOperator(address owner, address operator) view returns (bool)",
  "function setOperator(address operator, bool approved) returns (bool)"
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
const router   = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, wallet);
const curve    = new ethers.Contract(CURVE_ADDR, CURVE_ABI, provider);
const lens     = new ethers.Contract(LENS_ADDR, LENS_ABI, provider);

// === GUESS ENCODING (from 42 frontend) ===
// dataGuess = abi.encode(uint256 otDeltaGuessOffchain, uint256 maxIterations, uint256 eps)
const DEFAULT_MAX_ITER = 50n;

function smartEps(collateralAmount) {
  if (collateralAmount < 5)    return 200000000000000000n; // 20% for tiny trades
  if (collateralAmount <= 3000) return 1000000000000000n;  // 0.1% normal
  return BigInt(Math.floor((1 / collateralAmount) * 1e18)); // proportional for large
}

function encodeDataGuess(guessOffchain, maxIter = DEFAULT_MAX_ITER, eps = 1000000000000000n) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "uint256"],
    [guessOffchain, maxIter, eps]
  );
}

// === HELPERS ===
async function getFactory() {
  const addr = await router.controller();
  return new ethers.Contract(addr, FACTORY_ABI, provider);
}

async function ensureERC20Approval(spender, amount) {
  const usdt = new ethers.Contract(USDT_ADDR, ERC20_ABI, wallet);
  const current = await usdt.allowance(WALLET, spender);
  if (current < amount) {
    console.log("  Approving USDT for", spender.slice(0, 10) + "...");
    const tx = await usdt.approve(spender, ethers.MaxUint256);
    await tx.wait();
    console.log("  Approved!");
  }
}

async function ensureERC6909Approval(marketAddr, tokenId, amount) {
  const mkt = new ethers.Contract(marketAddr, ERC6909_ABI, wallet);
  const current = await mkt.allowance(WALLET, ROUTER_ADDR, tokenId);
  if (current < amount) {
    console.log("  Approving tokenId", tokenId, "for Router...");
    const tx = await mkt.approve(ROUTER_ADDR, tokenId, ethers.MaxUint256);
    await tx.wait();
    console.log("  Approved!");
  }
}

// === SIMULATION via Lens ===
async function simulateBuy(marketAddr, tokenId, usdtAmount) {
  const amountWei = ethers.parseUnits(usdtAmount.toString(), 18);
  const notional = parseFloat(usdtAmount);
  const eps = smartEps(notional);
  const dataGuess = encodeDataGuess(0n, 100n, eps); // 100 iterations for sim

  const result = await lens.simulateMintNoUser.staticCall(
    marketAddr, tokenId, amountWei, true, "0x", dataGuess
  );
  return {
    priceBefore: result.pre.price,
    priceAfter: result.post.price,
    otToUser: result.quote.otToUser,
    costFromUser: result.quote.collateralFromUser,
    feeToTreasury: result.quote.collateralToTreasury
  };
}

async function simulateSell(marketAddr, tokenId, otAmountWei) {
  const result = await lens.simulateRedeemNoUser.staticCall(
    marketAddr, tokenId, otAmountWei, true, "0x", "0x"
  );
  return {
    priceBefore: result.pre.price,
    priceAfter: result.post.price,
    collateralToUser: result.quote.collateralToUser,
    feeToTreasury: result.quote.collateralToTreasury,
    otFromUser: result.quote.otFromUser,
    spread: result.quote.collateralMintValue
  };
}

// === BUY ===
async function buyOutcome(marketAddr, tokenId, usdtAmount, slippagePct = 1) {
  const amountWei = ethers.parseUnits(usdtAmount.toString(), 18);

  // Step 1: Simulate to get expected OT out
  console.log("\n  Simulating buy...");
  const sim = await simulateBuy(marketAddr, tokenId, usdtAmount);
  const expectedOt = sim.otToUser;
  console.log("  Expected OT:", ethers.formatUnits(expectedOt, 18));
  console.log("  Price before:", ethers.formatUnits(sim.priceBefore, 18));
  console.log("  Price after:", ethers.formatUnits(sim.priceAfter, 18));
  console.log("  Fee:", ethers.formatUnits(sim.feeToTreasury, 18), "USDT");

  // Step 2: Ensure USDT approval
  await ensureERC20Approval(ROUTER_ADDR, amountWei);

  // Step 3: Build swap with dataGuess (using sim result as offchain hint)
  const notional = parseFloat(usdtAmount);
  const eps = smartEps(notional);
  const dataGuess = encodeDataGuess(expectedOt, DEFAULT_MAX_ITER, eps);

  // Slippage: minOtOut = expectedOt * (100 - slippage%) / 100
  const slippageBips = BigInt(Math.floor(slippagePct * 100));
  const minOtOut = (expectedOt * (10000n - slippageBips)) / 10000n;

  const iface = new ethers.Interface(ROUTER_ABI);

  // Transfer USDT into Router
  const transferCall = iface.encodeFunctionData("erc20TransferFromInitiator", [
    USDT_ADDR, ROUTER_ADDR, amountWei
  ]);

  // Swap
  const swapCall = iface.encodeFunctionData("swapSimple", [
    marketAddr, WALLET, tokenId,
    { isMint: true, amount: amountWei, isExactIn: true, minOutOrMaxIn: minOtOut },
    "0x", dataGuess
  ]);

  const calls = [
    { allowFailure: false, callData: transferCall },
    { allowFailure: false, callData: swapCall }
  ];

  console.log("  Slippage:", slippagePct + "%", "| Min OT:", ethers.formatUnits(minOtOut, 18));
  console.log("  Executing...");

  const tx = await router.multicall(calls, { gasLimit: 800000 });
  console.log("  TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("  Confirmed block", receipt.blockNumber, "| Gas:", receipt.gasUsed.toString());
  return receipt;
}

// === SELL ===
async function sellOutcome(marketAddr, tokenId, otAmount, slippagePct = 1) {
  const otAmountWei = typeof otAmount === "bigint" ? otAmount : ethers.parseUnits(otAmount.toString(), 18);

  // Step 1: Simulate
  console.log("\n  Simulating sell...");
  const sim = await simulateSell(marketAddr, tokenId, otAmountWei);
  const expectedCollateral = sim.collateralToUser;
  console.log("  Expected USDT back:", ethers.formatUnits(expectedCollateral, 18));
  console.log("  Price before:", ethers.formatUnits(sim.priceBefore, 18));
  console.log("  Price after:", ethers.formatUnits(sim.priceAfter, 18));
  console.log("  Fee:", ethers.formatUnits(sim.feeToTreasury, 18), "USDT");

  // Step 2: Ensure ERC6909 approval for this tokenId
  await ensureERC6909Approval(marketAddr, tokenId, otAmountWei);

  // Step 3: Slippage
  const slippageBips = BigInt(Math.floor(slippagePct * 100));
  const minCollateral = (expectedCollateral * (10000n - slippageBips)) / 10000n;

  const iface = new ethers.Interface(ROUTER_ABI);
  const swapCall = iface.encodeFunctionData("swapSimple", [
    marketAddr, WALLET, tokenId,
    { isMint: false, amount: otAmountWei, isExactIn: true, minOutOrMaxIn: minCollateral },
    "0x", "0x" // no dataGuess needed for sells
  ]);

  const calls = [{ allowFailure: false, callData: swapCall }];

  console.log("  Slippage:", slippagePct + "%", "| Min USDT:", ethers.formatUnits(minCollateral, 18));
  console.log("  Executing...");

  const tx = await router.multicall(calls, { gasLimit: 800000 });
  console.log("  TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("  Confirmed block", receipt.blockNumber, "| Gas:", receipt.gasUsed.toString());
  return receipt;
}

// === CLAIM ===
async function claimWinnings(marketAddr) {
  // setOperator is needed for claim
  const mkt = new ethers.Contract(marketAddr, ERC6909_ABI, wallet);
  const isOp = await mkt.isOperator(WALLET, ROUTER_ADDR);
  if (!isOp) {
    console.log("  Setting Router as operator for claim...");
    const tx = await mkt.setOperator(ROUTER_ADDR, true);
    await tx.wait();
  }

  console.log("  Claiming...");
  const tx = await router.claimAllSimple(marketAddr, WALLET);
  console.log("  TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("  Claimed!");
  return receipt;
}

// === INFO ===
async function showInfo(marketAddr) {
  const factory = await getFactory();
  const config = await factory.getConfig(marketAddr);
  const numOutcomes = Number(config._numOutcomes);

  console.log("Market:", marketAddr);
  console.log("  Outcomes:", numOutcomes);
  console.log("  Fee rate:", (Number(config._feeRate) / 1e18 * 100).toFixed(2) + "%");
  console.log("  End:", new Date(Number(config._timestampEnd) * 1000).toISOString());
  console.log("  Finalised:", config._isFinalised);

  // Get outcome names
  const MARKET_ABI2 = ["function questionId() view returns (bytes32)"];
  const mktContract = new ethers.Contract(marketAddr, MARKET_ABI2, provider);
  let names = [];
  try {
    const qid = await mktContract.questionId();
    names = await factory.getOutcomeNames(qid);
  } catch(e) { /* names unavailable */ }

  // Use Lens for snapshot
  try {
    const snapshot = await lens.snapshotMarket.staticCall(marketAddr);
    console.log("  Total market cap:", ethers.formatUnits(snapshot.state.totalMarketCap, 18), "USDT");
    console.log("");
    for (let i = 0; i < numOutcomes; i++) {
      const ot = snapshot.ots[i];
      const name = names[i] || `Token ${i}`;
      const price = ethers.formatUnits(ot.price, 18);
      const supply = ethers.formatUnits(ot.supply, 18);
      const payout = ethers.formatUnits(ot.payoutPerOt, 18);
      console.log(`  [${i}] ${name}`);
      console.log(`      Price: ${price} USDT | Supply: ${supply} OT | Payout/OT: ${payout}`);
    }
  } catch(e) {
    // Fallback to curve reads
    for (let i = 0; i < numOutcomes; i++) {
      try {
        const price = await curve.calMarginalPrice(marketAddr, i);
        const state = await curve.readMarketState(marketAddr, i);
        const name = names[i] || `Token ${i}`;
        console.log(`  [${i}] ${name}: price=${ethers.formatUnits(price, 18)} USDT, supply=${ethers.formatUnits(state.otCurrent, 18)} OT`);
      } catch(e2) {
        console.log(`  [${i}] error: ${e2.message?.slice(0, 60)}`);
      }
    }
  }
}

// === QUOTE ===
async function showQuote(marketAddr, tokenId, usdtAmount) {
  const price = await curve.calMarginalPrice(marketAddr, tokenId);
  console.log("Current price:", ethers.formatUnits(price, 18), "USDT");

  if (usdtAmount) {
    console.log("\nBuy quote for", usdtAmount, "USDT:");
    const sim = await simulateBuy(marketAddr, tokenId, usdtAmount);
    console.log("  OT you'd get:", ethers.formatUnits(sim.otToUser, 18));
    console.log("  Actual cost:", ethers.formatUnits(sim.costFromUser, 18), "USDT");
    console.log("  Fee:", ethers.formatUnits(sim.feeToTreasury, 18), "USDT");
    console.log("  Price impact:", ethers.formatUnits(sim.priceBefore, 18), "→", ethers.formatUnits(sim.priceAfter, 18));
  }
}

// === PORTFOLIO ===
async function showPortfolio(marketAddr) {
  const mkt = new ethers.Contract(marketAddr, ERC6909_ABI, provider);
  const factory = await getFactory();
  const config = await factory.getConfig(marketAddr);
  const numOutcomes = Number(config._numOutcomes);

  console.log("Portfolio for", WALLET.slice(0,6) + "..." + WALLET.slice(-4), "on", marketAddr.slice(0,10) + "...");
  let totalValue = 0;
  for (let i = 0; i < numOutcomes; i++) {
    const bal = await mkt.balanceOf(WALLET, i);
    if (bal > 0n) {
      const price = await curve.calMarginalPrice(marketAddr, i);
      const balFmt = parseFloat(ethers.formatUnits(bal, 18));
      const priceFmt = parseFloat(ethers.formatUnits(price, 18));
      const value = balFmt * priceFmt;
      totalValue += value;
      console.log(`  Token ${i}: ${balFmt} OT × ${priceFmt.toFixed(6)} = ${value.toFixed(4)} USDT`);
    }
  }
  if (totalValue === 0) console.log("  No positions");
  else console.log("  Total value: ~" + totalValue.toFixed(4) + " USDT");
}

// === MAIN ===
async function main() {
  const action = process.argv[2];

  if (!action || action === "status") {
    const usdt = new ethers.Contract(USDT_ADDR, ERC20_ABI, provider);
    const bal = await usdt.balanceOf(WALLET);
    const bnb = await provider.getBalance(WALLET);
    console.log("Wallet:", WALLET);
    console.log("  BNB:", ethers.formatEther(bnb));
    console.log("  USDT:", ethers.formatUnits(bal, 18));
    const allowance = await usdt.allowance(WALLET, ROUTER_ADDR);
    console.log("  USDT allowance for Router:", allowance > 0n ? "unlimited" : "none");

  } else if (action === "info") {
    await showInfo(process.argv[3]);

  } else if (action === "quote") {
    await showQuote(process.argv[3], parseInt(process.argv[4]), process.argv[5]);

  } else if (action === "buy") {
    const slippage = process.argv[6] ? parseFloat(process.argv[6]) : 1;
    await buyOutcome(process.argv[3], parseInt(process.argv[4]), process.argv[5], slippage);

  } else if (action === "sell") {
    const slippage = process.argv[6] ? parseFloat(process.argv[6]) : 1;
    await sellOutcome(process.argv[3], parseInt(process.argv[4]), process.argv[5], slippage);

  } else if (action === "claim") {
    await claimWinnings(process.argv[3]);

  } else if (action === "portfolio") {
    await showPortfolio(process.argv[3]);

  } else {
    console.log("42.space Trading CLI v2.0");
    console.log("");
    console.log("Usage:");
    console.log("  node trade.js                                  — wallet status");
    console.log("  node trade.js info <market>                    — market details + all outcomes");
    console.log("  node trade.js quote <market> <tokenId> [usdt]  — price quote with simulation");
    console.log("  node trade.js buy <market> <tokenId> <usdt> [slippage%]  — buy outcome tokens");
    console.log("  node trade.js sell <market> <tokenId> <amount> [slippage%] — sell outcome tokens");
    console.log("  node trade.js claim <market>                   — claim winnings");
    console.log("  node trade.js portfolio <market>               — show positions");
    console.log("");
    console.log("Environment: BSC_PRIVATE_KEY, BSC_WALLET_ADDRESS, BSC_RPC (optional)");
  }
}

main().catch(e => {
  console.error("ERROR:", e.message || e);
  if (e.data) console.error("Data:", e.data);
  process.exit(1);
});
