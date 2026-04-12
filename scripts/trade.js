const { ethers } = require("ethers");
const path = require("path");

// === CONFIG ===
const RPC = "https://bsc-dataseed1.binance.org";
const PRIVATE_KEY = process.env.BSC_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("ERROR: Set BSC_PRIVATE_KEY env var"); process.exit(1); }
const ROUTER = "0x88888888338e60bfB4657187169cFFa5c8640E42";
const CURVE  = "0x0443E04e70E4285a6cA73eacaC5267f3B4cBb7Da";
const USDT   = "0x55d398326f99059fF775485246999027B3197955";
const WALLET = process.env.BSC_WALLET_ADDRESS;
if (!WALLET) { console.error("ERROR: Set BSC_WALLET_ADDRESS env var"); process.exit(1); }

// ABIs
const ROUTER_ABI  = require("./contracts/router_abi.json");
const FACTORY_ABI = require("./contracts/factory_abi.json");
const CURVE_ABI   = require("./contracts/curve_abi.json");
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
const curve  = new ethers.Contract(CURVE, CURVE_ABI, provider);

// === HELPERS ===
async function getFactory() {
  const controllerAddr = await router.controller();
  return new ethers.Contract(controllerAddr, FACTORY_ABI, provider);
}

async function ensureApproval(amount) {
  const token = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const current = await token.allowance(WALLET, ROUTER);
  if (current < amount) {
    console.log("Approving USDT for Router...");
    const tx = await token.approve(ROUTER, ethers.MaxUint256);
    await tx.wait();
    console.log("Approved! tx:", tx.hash);
  } else {
    console.log("USDT already approved for Router");
  }
}

// === PRICE QUOTE ===
async function getPrice(marketAddr, tokenId) {
  const price = await curve.calMarginalPrice(marketAddr, tokenId);
  return price;
}

async function quoteBuy(marketAddr, tokenId, usdtAmount) {
  const amountIn = ethers.parseUnits(usdtAmount.toString(), 18);
  // Empty bytes works - the curve uses its default binary search params
  const [otDelta, collateralFromUser] = await curve.calOtDeltaByMintCost(
    marketAddr, tokenId, amountIn, "0x"
  );
  return { otDelta, collateralFromUser };
}

// === BUY ===
async function buyOutcome(marketAddr, tokenId, usdtAmount) {
  const amountIn = ethers.parseUnits(usdtAmount.toString(), 18);
  await ensureApproval(amountIn);

  const iface = new ethers.Interface(ROUTER_ABI);

  // Call 1: Transfer USDT into the router
  const transferCall = iface.encodeFunctionData("erc20TransferFromInitiator", [
    USDT, ROUTER, amountIn
  ]);

  // Call 2: swapSimple with isMint=true
  const swapParams = {
    isMint: true,
    amount: amountIn,
    isExactIn: true,
    minOutOrMaxIn: 0n  // no slippage for test
  };

  const swapCall = iface.encodeFunctionData("swapSimple", [
    marketAddr, WALLET, tokenId, swapParams, "0x", "0x"
  ]);

  const calls = [
    { allowFailure: false, callData: transferCall },
    { allowFailure: false, callData: swapCall }
  ];

  console.log(`\nBuying tokenId=${tokenId} on ${marketAddr}`);
  console.log(`Spending: ${usdtAmount} USDT`);

  const tx = await router.multicall(calls, { gasLimit: 800000 });
  console.log("TX:", tx.hash);
  const receipt = await tx.wait();
  console.log(`Confirmed block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  return receipt;
}

// === SELL ===
async function sellOutcome(marketAddr, tokenId, otAmount) {
  const iface = new ethers.Interface(ROUTER_ABI);

  const swapParams = {
    isMint: false,
    amount: BigInt(otAmount),
    isExactIn: true,
    minOutOrMaxIn: 0n
  };

  const swapCall = iface.encodeFunctionData("swapSimple", [
    marketAddr, WALLET, tokenId, swapParams, "0x", "0x"
  ]);

  const calls = [
    { allowFailure: false, callData: swapCall }
  ];

  console.log(`\nSelling ${otAmount} OT of tokenId=${tokenId} on ${marketAddr}`);
  const tx = await router.multicall(calls, { gasLimit: 800000 });
  console.log("TX:", tx.hash);
  const receipt = await tx.wait();
  console.log(`Confirmed block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  return receipt;
}

// === CLAIM ===
async function claimWinnings(marketAddr) {
  console.log(`\nClaiming from ${marketAddr}...`);
  const tx = await router.claimAllSimple(marketAddr, WALLET);
  console.log("TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("Claimed!");
  return receipt;
}

// === INFO ===
async function showInfo(marketAddr) {
  const factory = await getFactory();
  const config = await factory.getConfig(marketAddr);
  console.log("Market:", marketAddr);
  console.log("  Outcomes:", config._numOutcomes.toString());
  console.log("  Fee rate:", config._feeRate.toString());
  console.log("  End:", new Date(Number(config._timestampEnd) * 1000).toISOString());
  console.log("  Answer:", config._answer.toString());
  console.log("  Finalised:", config._isFinalised);

  // Prices for each outcome
  for (let i = 0; i < Number(config._numOutcomes); i++) {
    try {
      const price = await curve.calMarginalPrice(marketAddr, i);
      const priceFmt = ethers.formatUnits(price, 18);
      
      const state = await curve.readMarketState(marketAddr, i);
      const otCurrent = state.otCurrent;
      
      console.log(`  Token ${i}: price=${priceFmt} USDT, supply=${ethers.formatUnits(otCurrent, 18)} OT`);
    } catch (e) {
      console.log(`  Token ${i}: error reading - ${e.message?.slice(0, 80)}`);
    }
  }
}

// === MAIN ===
async function main() {
  const action = process.argv[2];

  if (!action || action === "status") {
    const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
    const bal = await usdt.balanceOf(WALLET);
    const bnb = await provider.getBalance(WALLET);
    console.log(`Wallet: ${WALLET}`);
    console.log(`BNB:  ${ethers.formatEther(bnb)}`);
    console.log(`USDT: ${ethers.formatUnits(bal, 18)}`);

    const allowance = await usdt.allowance(WALLET, ROUTER);
    console.log(`USDT allowance for Router: ${ethers.formatUnits(allowance, 18)}`);

  } else if (action === "info") {
    await showInfo(process.argv[3]);

  } else if (action === "quote") {
    // node trade.js quote <market> <tokenId> <usdtAmount>
    const market = process.argv[3];
    const tokenId = parseInt(process.argv[4]);
    const amount = process.argv[5];
    const price = await curve.calMarginalPrice(market, tokenId);
    console.log(`Current price: ${ethers.formatUnits(price, 18)} USDT`);
    if (amount) {
      try {
        const q = await quoteBuy(market, tokenId, amount);
        console.log(`For ${amount} USDT you'd get: ${ethers.formatUnits(q.otDelta, 18)} OT`);
        console.log(`Actual cost: ${ethers.formatUnits(q.collateralFromUser, 18)} USDT`);
      } catch(e) {
        console.log(`Quote failed: ${e.message?.slice(0, 120)}`);
      }
    }

  } else if (action === "buy") {
    await buyOutcome(process.argv[3], parseInt(process.argv[4]), process.argv[5]);

  } else if (action === "sell") {
    await sellOutcome(process.argv[3], parseInt(process.argv[4]), process.argv[5]);

  } else if (action === "claim") {
    await claimWinnings(process.argv[3]);

  } else {
    console.log("Usage:");
    console.log("  node trade.js                          - wallet status");
    console.log("  node trade.js info <market>            - market details + prices");
    console.log("  node trade.js quote <market> <id> [amt]- price quote");
    console.log("  node trade.js buy <market> <id> <usdt> - buy outcome tokens");
    console.log("  node trade.js sell <market> <id> <ot>  - sell outcome tokens");
    console.log("  node trade.js claim <market>           - claim winnings");
  }
}

main().catch(e => {
  console.error("ERROR:", e.message || e);
  if (e.data) console.error("Data:", e.data);
  process.exit(1);
});
