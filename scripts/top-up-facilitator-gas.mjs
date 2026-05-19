import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_X402_REPO_DIR = path.resolve(SCRIPT_DIR, "../../zeko-x402");

const BASE_CONFIG = {
  rail: "base",
  networkLabel: "base-mainnet",
  chainImport: "base",
  rpcEnvNames: ["X402_BASE_RPC_URL", "X402_BASE_MAINNET_RPC_URL", "BASE_RPC_URL"],
  sourcePrivateKeyEnvNames: [
    "CLAWZ_BASE_FACILITATOR_GAS_TREASURY_PRIVATE_KEY",
    "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_PRIVATE_KEY",
    "X402_BASE_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ],
  targetAddressEnvNames: [
    "CLAWZ_BASE_FACILITATOR_GAS_TARGET_ADDRESS",
    "CLAWZ_BASE_FACILITATOR_ADDRESS",
    "X402_BASE_RELAYER_ADDRESS"
  ],
  targetPrivateKeyEnvNames: ["X402_BASE_RELAYER_PRIVATE_KEY", "X402_EVM_RELAYER_PRIVATE_KEY"],
  defaultRpcUrl: "https://mainnet.base.org",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  wethAddress: "0x4200000000000000000000000000000000000006",
  uniswapSwapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  uniswapQuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  aerodromeRouter: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  aerodromeFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  defaultMinNativeEth: "0.01",
  defaultTargetNativeEth: "0.2",
  defaultMaxUsdcPerRun: "1000",
  supportsAerodrome: true
};

const ETHEREUM_CONFIG = {
  rail: "ethereum",
  networkLabel: "ethereum-mainnet",
  chainImport: "mainnet",
  rpcEnvNames: ["X402_ETHEREUM_RPC_URL", "X402_ETHEREUM_MAINNET_RPC_URL", "ETHEREUM_RPC_URL"],
  sourcePrivateKeyEnvNames: [
    "CLAWZ_ETHEREUM_FACILITATOR_GAS_TREASURY_PRIVATE_KEY",
    "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_PRIVATE_KEY",
    "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ],
  targetAddressEnvNames: [
    "CLAWZ_ETHEREUM_FACILITATOR_GAS_TARGET_ADDRESS",
    "CLAWZ_ETHEREUM_FACILITATOR_ADDRESS",
    "X402_ETHEREUM_RELAYER_ADDRESS"
  ],
  targetPrivateKeyEnvNames: ["X402_ETHEREUM_RELAYER_PRIVATE_KEY", "X402_EVM_RELAYER_PRIVATE_KEY"],
  defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
  usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  wethAddress: "0xC02aaA39b223FE8D0A0e5C4F27ead9083C756Cc2",
  uniswapSwapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  uniswapQuoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  aerodromeRouter: null,
  aerodromeFactory: null,
  defaultMinNativeEth: "0.03",
  defaultTargetNativeEth: "0.2",
  defaultMaxUsdcPerRun: "1500",
  supportsAerodrome: false
};

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function optionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function requiredEnv(...names) {
  const value = optionalEnv(...names);
  if (!value) {
    throw new Error(`Missing required env var: ${names.join(" or ")}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  pnpm top-up:facilitator-gas -- --rail base
  pnpm top-up:facilitator-gas -- --rail base --execute

Base behavior:
  1. check the facilitator target's native ETH balance
  2. if it is below --min-native-eth, quote the shortfall to --target-native-eth
  3. price both Uniswap v3 and Aerodrome on Base when --route best
  4. swap treasury USDC to native ETH and send it to the facilitator target

Options:
  --rail base|ethereum              Rail to top up. Defaults to base.
  --route best|uniswap|aerodrome    Route choice. Defaults to best. Aerodrome is Base-only.
  --min-native-eth <amount>         Trigger threshold. Defaults to 0.01 on Base.
  --target-native-eth <amount>      Desired target balance. Defaults to 0.2.
  --max-usdc-per-run <amount>       Safety cap for a single top-up. Defaults to 1000 on Base.
  --slippage-bps <bps>              Slippage guard. Defaults to 100.
  --uniswap-pool-fee <fee>          Uniswap v3 pool fee. Defaults to 500.
  --aerodrome-stable true|false     Aerodrome stable route flag. Defaults to false for USDC/WETH.
  --target-address <address>        Facilitator address receiving native ETH.
  --execute                         Broadcast approve/swap transactions. Without this, dry-run only.
  --x402-repo-dir <path>            Local zeko-x402 repo used for viem dependencies. Defaults to ../zeko-x402.
  --help                            Show this message.

Environment:
  Base RPC: X402_BASE_RPC_URL or X402_BASE_MAINNET_RPC_URL
  Base treasury key: CLAWZ_BASE_FACILITATOR_GAS_TREASURY_PRIVATE_KEY
  Base target address: CLAWZ_BASE_FACILITATOR_GAS_TARGET_ADDRESS
  Base relayer fallback target: X402_BASE_RELAYER_PRIVATE_KEY or X402_BASE_RELAYER_ADDRESS
`);
}

function railConfig(rail) {
  return rail === "ethereum" ? ETHEREUM_CONFIG : BASE_CONFIG;
}

function normalizedRoute(value, supportsAerodrome) {
  const route = String(value ?? "best").toLowerCase();
  if (!["best", "uniswap", "aerodrome"].includes(route)) {
    throw new Error("Route must be best, uniswap, or aerodrome.");
  }
  if (route === "aerodrome" && !supportsAerodrome) {
    throw new Error("Aerodrome route is only available on Base.");
  }
  return route;
}

function readConfig(args) {
  const config = railConfig(String(args.rail ?? "base").toLowerCase());
  const minNativeEth =
    args["min-native-eth"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH",
      "CLAWZ_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH"
    ) ??
    config.defaultMinNativeEth;
  const targetNativeEth =
    args["target-native-eth"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_TARGET_NATIVE_ETH"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_TARGET_NATIVE_ETH",
      "CLAWZ_FACILITATOR_GAS_TOPUP_TARGET_NATIVE_ETH"
    ) ??
    config.defaultTargetNativeEth;
  const maxUsdcPerRun =
    args["max-usdc-per-run"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_MAX_USDC"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MAX_USDC",
      "CLAWZ_FACILITATOR_GAS_TOPUP_MAX_USDC"
    ) ??
    config.defaultMaxUsdcPerRun;
  const slippageBps =
    args["slippage-bps"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS",
      "CLAWZ_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS"
    ) ??
    "100";
  const uniswapPoolFee =
    args["uniswap-pool-fee"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_UNISWAP_POOL_FEE"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_UNISWAP_POOL_FEE",
      "CLAWZ_FACILITATOR_GAS_TOPUP_UNISWAP_POOL_FEE"
    ) ??
    "500";
  const aerodromeStable =
    args["aerodrome-stable"] ??
    optionalEnv("CLAWZ_BASE_FACILITATOR_GAS_TOPUP_AERODROME_STABLE") ??
    "false";
  const route = normalizedRoute(
    args.route ??
      optionalEnv(
        config.rail === "ethereum"
          ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_ROUTE"
          : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_ROUTE",
        "CLAWZ_FACILITATOR_GAS_TOPUP_ROUTE"
      ),
    config.supportsAerodrome
  );

  return {
    ...config,
    rpcUrl: optionalEnv(...config.rpcEnvNames) ?? config.defaultRpcUrl,
    sourcePrivateKey: requiredEnv(...config.sourcePrivateKeyEnvNames),
    targetAddress: args["target-address"] ?? optionalEnv(...config.targetAddressEnvNames),
    targetPrivateKey: optionalEnv(...config.targetPrivateKeyEnvNames),
    minNativeEth,
    targetNativeEth,
    maxUsdcPerRun,
    slippageBps,
    uniswapPoolFee,
    aerodromeStable: aerodromeStable === "true" ? "true" : "false",
    route,
    execute: args.execute === "true",
    x402RepoDir: args["x402-repo-dir"] ? path.resolve(String(args["x402-repo-dir"])) : DEFAULT_X402_REPO_DIR
  };
}

function topUpSnippet(config) {
  return `
    import {
      createPublicClient,
      createWalletClient,
      encodeFunctionData,
      formatUnits,
      getAddress,
      http,
      parseUnits
    } from "viem";
    import { privateKeyToAccount } from "viem/accounts";
    import { ${config.chainImport} as chain } from "viem/chains";

    const ERC20_ABI = [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }]
      },
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" }
        ],
        outputs: [{ name: "", type: "uint256" }]
      },
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        outputs: [{ name: "", type: "bool" }]
      }
    ];

    const UNISWAP_QUOTER_V2_ABI = [
      {
        type: "function",
        name: "quoteExactOutputSingle",
        stateMutability: "nonpayable",
        inputs: [
          {
            name: "params",
            type: "tuple",
            components: [
              { name: "tokenIn", type: "address" },
              { name: "tokenOut", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "fee", type: "uint24" },
              { name: "sqrtPriceLimitX96", type: "uint160" }
            ]
          }
        ],
        outputs: [
          { name: "amountIn", type: "uint256" },
          { name: "sqrtPriceX96After", type: "uint160" },
          { name: "initializedTicksCrossed", type: "uint32" },
          { name: "gasEstimate", type: "uint256" }
        ]
      }
    ];

    const UNISWAP_SWAP_ROUTER_ABI = [
      {
        type: "function",
        name: "exactOutputSingle",
        stateMutability: "payable",
        inputs: [
          {
            name: "params",
            type: "tuple",
            components: [
              { name: "tokenIn", type: "address" },
              { name: "tokenOut", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "recipient", type: "address" },
              { name: "deadline", type: "uint256" },
              { name: "amountOut", type: "uint256" },
              { name: "amountInMaximum", type: "uint256" },
              { name: "sqrtPriceLimitX96", type: "uint160" }
            ]
          }
        ],
        outputs: [{ name: "amountIn", type: "uint256" }]
      },
      {
        type: "function",
        name: "unwrapWETH9",
        stateMutability: "payable",
        inputs: [
          { name: "amountMinimum", type: "uint256" },
          { name: "recipient", type: "address" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "multicall",
        stateMutability: "payable",
        inputs: [{ name: "data", type: "bytes[]" }],
        outputs: [{ name: "results", type: "bytes[]" }]
      }
    ];

    const AERODROME_ROUTER_ABI = [
      {
        type: "function",
        name: "getAmountsOut",
        stateMutability: "view",
        inputs: [
          { name: "amountIn", type: "uint256" },
          {
            name: "routes",
            type: "tuple[]",
            components: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "stable", type: "bool" },
              { name: "factory", type: "address" }
            ]
          }
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }]
      },
      {
        type: "function",
        name: "swapExactTokensForETH",
        stateMutability: "nonpayable",
        inputs: [
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMin", type: "uint256" },
          {
            name: "routes",
            type: "tuple[]",
            components: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "stable", type: "bool" },
              { name: "factory", type: "address" }
            ]
          },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" }
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }]
      }
    ];

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const sourceAccount = privateKeyToAccount(process.env.SOURCE_PRIVATE_KEY);
    const fallbackTarget = process.env.TARGET_PRIVATE_KEY
      ? privateKeyToAccount(process.env.TARGET_PRIVATE_KEY).address
      : sourceAccount.address;
    const targetAddress = getAddress(process.env.TARGET_ADDRESS || fallbackTarget);
    const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });
    const walletClient = createWalletClient({ account: sourceAccount, chain, transport: http(process.env.RPC_URL) });
    const usdcAddress = getAddress(process.env.USDC_ADDRESS);
    const wethAddress = getAddress(process.env.WETH_ADDRESS);
    const uniswapRouterAddress = getAddress(process.env.UNISWAP_ROUTER_ADDRESS);
    const uniswapQuoterAddress = getAddress(process.env.UNISWAP_QUOTER_ADDRESS);
    const aerodromeRouterAddress = process.env.AERODROME_ROUTER_ADDRESS
      ? getAddress(process.env.AERODROME_ROUTER_ADDRESS)
      : null;
    const aerodromeFactoryAddress = process.env.AERODROME_FACTORY_ADDRESS
      ? getAddress(process.env.AERODROME_FACTORY_ADDRESS)
      : ZERO_ADDRESS;
    const uniswapPoolFee = Number(process.env.UNISWAP_POOL_FEE);
    const slippageBps = BigInt(process.env.SLIPPAGE_BPS);
    const execute = process.env.EXECUTE === "true";
    const requestedRoute = process.env.ROUTE;
    const minNative = parseUnits(process.env.MIN_NATIVE_ETH, 18);
    const targetNative = parseUnits(process.env.TARGET_NATIVE_ETH, 18);
    const maxUsdcPerRun = parseUnits(process.env.MAX_USDC_PER_RUN, 6);
    const aerodromeStable = process.env.AERODROME_STABLE === "true";
    const nativeBalanceBefore = await publicClient.getBalance({ address: targetAddress });
    const sourceNativeBalanceBefore = await publicClient.getBalance({ address: sourceAccount.address });
    const sourceUsdcBalanceBefore = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [sourceAccount.address]
    });

    function applyBpsUp(amount, bps) {
      return (amount * (10000n + bps) + 9999n) / 10000n;
    }

    function ceilDiv(numerator, denominator) {
      return (numerator + denominator - 1n) / denominator;
    }

    function serializeQuote(quote) {
      return {
        venue: quote.venue,
        spender: quote.spender,
        amountIn: formatUnits(quote.amountIn, 6),
        amountInMaximum: formatUnits(quote.amountInMaximum, 6),
        quotedNativeOut: formatUnits(quote.quotedNativeOut, 18),
        amountOutMinimum: formatUnits(quote.amountOutMinimum, 18),
        gasEstimate: quote.gasEstimate?.toString()
      };
    }

    async function quoteUniswap(desiredNativeOut) {
      const simulation = await publicClient.simulateContract({
        account: sourceAccount,
        address: uniswapQuoterAddress,
        abi: UNISWAP_QUOTER_V2_ABI,
        functionName: "quoteExactOutputSingle",
        args: [{
          tokenIn: usdcAddress,
          tokenOut: wethAddress,
          amount: desiredNativeOut,
          fee: uniswapPoolFee,
          sqrtPriceLimitX96: 0n
        }]
      });
      const result = simulation.result;
      const amountIn = Array.isArray(result) ? result[0] : result.amountIn;
      const gasEstimate = Array.isArray(result) ? result[3] : result.gasEstimate;
      return {
        venue: "uniswap-v3",
        spender: uniswapRouterAddress,
        amountIn,
        amountInMaximum: applyBpsUp(amountIn, slippageBps),
        quotedNativeOut: desiredNativeOut,
        amountOutMinimum: desiredNativeOut,
        gasEstimate
      };
    }

    async function quoteAerodromeForInput(amountIn) {
      if (!aerodromeRouterAddress) {
        throw new Error("Aerodrome router is not configured for this rail.");
      }
      const routes = [{
        from: usdcAddress,
        to: wethAddress,
        stable: aerodromeStable,
        factory: aerodromeFactoryAddress
      }];
      const amounts = await publicClient.readContract({
        address: aerodromeRouterAddress,
        abi: AERODROME_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, routes]
      });
      return amounts[amounts.length - 1];
    }

    async function quoteAerodrome(desiredNativeOut, seedAmountIn) {
      const desiredQuotedOut = ceilDiv(desiredNativeOut * 10000n, 10000n - slippageBps);
      let probeAmountIn = seedAmountIn && seedAmountIn > 0n && seedAmountIn <= maxUsdcPerRun ? seedAmountIn : maxUsdcPerRun / 2n;
      if (probeAmountIn <= 0n) {
        probeAmountIn = 1n;
      }
      const probeOut = await quoteAerodromeForInput(probeAmountIn);
      if (probeOut <= 0n) {
        throw new Error("Aerodrome quote returned zero output.");
      }

      let amountIn = ceilDiv(desiredQuotedOut * probeAmountIn, probeOut);
      amountIn = applyBpsUp(amountIn, 25n);
      if (amountIn > maxUsdcPerRun) {
        amountIn = maxUsdcPerRun;
      }

      let quotedNativeOut = await quoteAerodromeForInput(amountIn);
      for (let attempt = 0; attempt < 3 && quotedNativeOut < desiredQuotedOut && amountIn < maxUsdcPerRun; attempt += 1) {
        amountIn = applyBpsUp(amountIn, 100n);
        if (amountIn > maxUsdcPerRun) {
          amountIn = maxUsdcPerRun;
        }
        quotedNativeOut = await quoteAerodromeForInput(amountIn);
      }

      if (quotedNativeOut < desiredQuotedOut) {
        throw new Error(
          "Aerodrome quote cannot reach target within max USDC per run. " +
            \`quotedNativeOut=\${formatUnits(quotedNativeOut, 18)} maxUsdc=\${formatUnits(maxUsdcPerRun, 6)}\`
        );
      }
      return {
        venue: "aerodrome",
        spender: aerodromeRouterAddress,
        amountIn,
        amountInMaximum: amountIn,
        quotedNativeOut,
        amountOutMinimum: desiredNativeOut
      };
    }

    async function buildQuotes(desiredNativeOut) {
      const candidates = [];
      const errors = [];
      let uniswapSeed;
      if (requestedRoute === "best" || requestedRoute === "uniswap") {
        try {
          const uniswapQuote = await quoteUniswap(desiredNativeOut);
          uniswapSeed = uniswapQuote.amountInMaximum;
          candidates.push(uniswapQuote);
        } catch (error) {
          errors.push({ venue: "uniswap-v3", error: error instanceof Error ? error.message : String(error) });
        }
      }
      if ((requestedRoute === "best" || requestedRoute === "aerodrome") && aerodromeRouterAddress) {
        try {
          candidates.push(await quoteAerodrome(desiredNativeOut, uniswapSeed));
        } catch (error) {
          errors.push({ venue: "aerodrome", error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (candidates.length === 0) {
        throw new Error(\`No usable gas top-up route quotes: \${JSON.stringify(errors)}\`);
      }
      candidates.sort((left, right) => {
        if (left.amountIn === right.amountIn) return 0;
        return left.amountIn < right.amountIn ? -1 : 1;
      });
      return { candidates, errors, selected: candidates[0] };
    }

    async function approveIfNeeded(spender, amount) {
      const allowance = await publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [sourceAccount.address, spender]
      });
      if (allowance >= amount) {
        return null;
      }
      const approvalHash = await walletClient.writeContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, amount]
      });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
      return approvalHash;
    }

    if (targetNative <= minNative) {
      throw new Error("Target native ETH must be greater than min native ETH.");
    }

    if (nativeBalanceBefore >= minNative) {
      console.log(JSON.stringify({
        ok: true,
        action: "noop",
        reason: "target_native_balance_at_or_above_threshold",
        network: process.env.NETWORK_LABEL,
        source: sourceAccount.address,
        target: targetAddress,
        targetNativeBalanceBefore: formatUnits(nativeBalanceBefore, 18),
        minNativeEth: process.env.MIN_NATIVE_ETH,
        targetNativeEth: process.env.TARGET_NATIVE_ETH,
        sourceUsdcBalanceBefore: formatUnits(sourceUsdcBalanceBefore, 6),
        sourceNativeBalanceBefore: formatUnits(sourceNativeBalanceBefore, 18)
      }));
      process.exit(0);
    }

    const desiredNativeOut = targetNative - nativeBalanceBefore;
    const quoteResult = await buildQuotes(desiredNativeOut);
    const selected = quoteResult.selected;

    const wouldExceedMaxUsdcPerRun = selected.amountInMaximum > maxUsdcPerRun;
    const treasuryHasEnoughUsdc = sourceUsdcBalanceBefore >= selected.amountInMaximum;

    if (!execute) {
      console.log(JSON.stringify({
        ok: true,
        action: "dry_run",
        network: process.env.NETWORK_LABEL,
        source: sourceAccount.address,
        target: targetAddress,
        requestedRoute,
        selectedRoute: selected.venue,
        targetNativeBalanceBefore: formatUnits(nativeBalanceBefore, 18),
        sourceNativeBalanceBefore: formatUnits(sourceNativeBalanceBefore, 18),
        sourceUsdcBalanceBefore: formatUnits(sourceUsdcBalanceBefore, 6),
        minNativeEth: process.env.MIN_NATIVE_ETH,
        targetNativeEth: process.env.TARGET_NATIVE_ETH,
        desiredNativeOut: formatUnits(desiredNativeOut, 18),
        maxUsdcPerRun: process.env.MAX_USDC_PER_RUN,
        wouldExceedMaxUsdcPerRun,
        treasuryHasEnoughUsdc,
        quotes: quoteResult.candidates.map(serializeQuote),
        quoteErrors: quoteResult.errors,
        slippageBps: Number(slippageBps),
        uniswapPoolFee,
        aerodromeStable,
        uniswapRouterAddress,
        uniswapQuoterAddress,
        aerodromeRouterAddress,
        aerodromeFactoryAddress
      }));
      process.exit(0);
    }

    if (wouldExceedMaxUsdcPerRun) {
      throw new Error(
        \`Selected route needs \${formatUnits(selected.amountInMaximum, 6)} USDC, above max \${process.env.MAX_USDC_PER_RUN} USDC.\`
      );
    }
    if (!treasuryHasEnoughUsdc) {
      throw new Error(
        \`Treasury \${sourceAccount.address} has \${formatUnits(sourceUsdcBalanceBefore, 6)} USDC but selected route needs up to \${formatUnits(selected.amountInMaximum, 6)} USDC.\`
      );
    }

    const approvalHash = await approveIfNeeded(selected.spender, selected.amountInMaximum);
    let swapHash;
    if (selected.venue === "uniswap-v3") {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const swapCall = encodeFunctionData({
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "exactOutputSingle",
        args: [{
          tokenIn: usdcAddress,
          tokenOut: wethAddress,
          fee: uniswapPoolFee,
          recipient: uniswapRouterAddress,
          deadline,
          amountOut: desiredNativeOut,
          amountInMaximum: selected.amountInMaximum,
          sqrtPriceLimitX96: 0n
        }]
      });
      const unwrapCall = encodeFunctionData({
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "unwrapWETH9",
        args: [desiredNativeOut, targetAddress]
      });
      swapHash = await walletClient.writeContract({
        address: uniswapRouterAddress,
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "multicall",
        args: [[swapCall, unwrapCall]]
      });
    } else {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const routes = [{
        from: usdcAddress,
        to: wethAddress,
        stable: aerodromeStable,
        factory: aerodromeFactoryAddress
      }];
      swapHash = await walletClient.writeContract({
        address: aerodromeRouterAddress,
        abi: AERODROME_ROUTER_ABI,
        functionName: "swapExactTokensForETH",
        args: [selected.amountIn, selected.amountOutMinimum, routes, targetAddress, deadline]
      });
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const nativeBalanceAfter = await publicClient.getBalance({ address: targetAddress });
    const sourceUsdcBalanceAfter = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [sourceAccount.address]
    });
    const sourceNativeBalanceAfter = await publicClient.getBalance({ address: sourceAccount.address });

    console.log(JSON.stringify({
      ok: true,
      action: "executed",
      network: process.env.NETWORK_LABEL,
      source: sourceAccount.address,
      target: targetAddress,
      selectedRoute: selected.venue,
      approvalHash,
      swapHash,
      receiptStatus: receipt.status,
      targetNativeBalanceBefore: formatUnits(nativeBalanceBefore, 18),
      targetNativeBalanceAfter: formatUnits(nativeBalanceAfter, 18),
      sourceNativeBalanceBefore: formatUnits(sourceNativeBalanceBefore, 18),
      sourceNativeBalanceAfter: formatUnits(sourceNativeBalanceAfter, 18),
      sourceUsdcBalanceBefore: formatUnits(sourceUsdcBalanceBefore, 6),
      sourceUsdcBalanceAfter: formatUnits(sourceUsdcBalanceAfter, 6),
      desiredNativeOut: formatUnits(desiredNativeOut, 18),
      selectedQuote: serializeQuote(selected),
      quoteErrors: quoteResult.errors,
      slippageBps: Number(slippageBps)
    }));
  `;
}

async function runTopUp(config) {
  const { stdout } = await execFileAsync("node", ["--input-type=module", "-e", topUpSnippet(config)], {
    cwd: config.x402RepoDir,
    env: {
      ...process.env,
      NETWORK_LABEL: config.networkLabel,
      RPC_URL: config.rpcUrl,
      SOURCE_PRIVATE_KEY: config.sourcePrivateKey,
      TARGET_ADDRESS: config.targetAddress ?? "",
      TARGET_PRIVATE_KEY: config.targetPrivateKey ?? "",
      USDC_ADDRESS: config.usdcAddress,
      WETH_ADDRESS: config.wethAddress,
      UNISWAP_ROUTER_ADDRESS: config.uniswapSwapRouter02,
      UNISWAP_QUOTER_ADDRESS: config.uniswapQuoterV2,
      AERODROME_ROUTER_ADDRESS: config.aerodromeRouter ?? "",
      AERODROME_FACTORY_ADDRESS: config.aerodromeFactory ?? "",
      MIN_NATIVE_ETH: config.minNativeEth,
      TARGET_NATIVE_ETH: config.targetNativeEth,
      MAX_USDC_PER_RUN: config.maxUsdcPerRun,
      SLIPPAGE_BPS: config.slippageBps,
      UNISWAP_POOL_FEE: config.uniswapPoolFee,
      AERODROME_STABLE: config.aerodromeStable,
      ROUTE: config.route,
      EXECUTE: config.execute ? "true" : "false"
    },
    maxBuffer: 1024 * 1024 * 20
  });
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines.at(-1));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    printHelp();
    return;
  }

  const config = readConfig(args);
  const result = await runTopUp(config);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("[clawz:top-up-facilitator-gas] failed", error);
  process.exit(1);
});
