// One-time chain-registry bootstrap. Safe to re-run (upserts by natural key).
// Chains/RPC/contracts live in the DB and are edited in the workspace admin —
// no Solana chain/RPC/program env. Run: `pnpm --filter @peridotvault/pid-api db:seed`
import { PrismaClient } from "@prisma/client";
import {
  SOLANA_DEVNET_REFERENCE,
  SOLANA_DEVNET_RPC,
  SOLANA_NAMESPACE,
  SOLANA_PROGRAM_ID,
  SOLANA_TESTNET_PROGRAM_ID,
  SOLANA_TESTNET_REFERENCE,
  SOLANA_TESTNET_RPC,
  STELLAR_NAMESPACE,
  STELLAR_TESTNET_EXPLORER,
  STELLAR_TESTNET_REFERENCE,
  STELLAR_TESTNET_RPC,
} from "../src/common/chains";

const prisma = new PrismaClient();

const EVM = [
  { reference: "10143", name: "monad-testnet", nativeSymbol: "MON", rpcEnv: "EVM_RPC_URL_10143" },
  { reference: "97", name: "bsc-testnet", nativeSymbol: "tBNB", rpcEnv: "EVM_RPC_URL_97" },
  { reference: "421614", name: "arbitrum-sepolia", nativeSymbol: "ETH", rpcEnv: "EVM_RPC_URL_421614" },
  { reference: "84532", name: "base-sepolia", nativeSymbol: "ETH", rpcEnv: "EVM_RPC_URL_84532" },
];

async function main(): Promise<void> {
  // The account-creation path resolves SOLANA_DEVNET_REFERENCE (common/chains.ts) —
  // the chain_accounts FK requires this row to exist. Admin edits RPC/contracts later.
  // No schema migration is needed for dual-cluster: adding a chain is a data row
  // (expand), and chain_accounts FKs by id so existing rows are untouched.
  const solana = await prisma.chain.upsert({
    where: { namespace_reference: { namespace: SOLANA_NAMESPACE, reference: SOLANA_DEVNET_REFERENCE } },
    update: {},
    create: {
      namespace: SOLANA_NAMESPACE,
      reference: SOLANA_DEVNET_REFERENCE,
      name: "solana-devnet",
      nativeSymbol: "SOL",
      decimals: 9,
      rpcUrls: [SOLANA_DEVNET_RPC],
      explorerUrl: "https://explorer.solana.com",
      isTestnet: true,
      isActive: true,
    },
  });
  await prisma.chainContract.upsert({
    where: { chainId_type: { chainId: solana.id, type: "program" } },
    // ANT-70: heal stale devnet rows on re-seed (old program CiwLJ1h… replaced by
    // fresh program 9oMG7e… via ANT-68 Option B; old program left untouched on-chain
    // so this remains the rollback path — re-seed with the old constant to revert).
    update: { address: SOLANA_PROGRAM_ID },
    create: { chainId: solana.id, type: "program", address: SOLANA_PROGRAM_ID, versionLabel: "v1" },
  });

  // Second Solana chain (ANT-15 req 1: dual-cluster registry). Keyed by the live
  // testnet genesis hash — distinct from the legacy devnet row key above. Each
  // row carries its own `program` contract so testnet can run a different
  // program id after its deploy; admins change it via the workspace admin API,
  // and the seed-time env overrides below are bootstrap-only.
  const solanaTestnet = await prisma.chain.upsert({
    where: { namespace_reference: { namespace: SOLANA_NAMESPACE, reference: SOLANA_TESTNET_REFERENCE } },
    update: {},
    create: {
      namespace: SOLANA_NAMESPACE,
      reference: SOLANA_TESTNET_REFERENCE,
      name: "solana-testnet",
      nativeSymbol: "SOL",
      decimals: 9,
      rpcUrls: [process.env.SOLANA_TESTNET_RPC ?? SOLANA_TESTNET_RPC],
      explorerUrl: "https://explorer.solana.com?cluster=testnet",
      isTestnet: true,
      isActive: true,
    },
  });
  await prisma.chainContract.upsert({
    where: { chainId_type: { chainId: solanaTestnet.id, type: "program" } },
    update: {},
    create: {
      chainId: solanaTestnet.id,
      type: "program",
      address: process.env.SOLANA_TESTNET_PROGRAM_ID ?? SOLANA_TESTNET_PROGRAM_ID,
      versionLabel: "v1",
    },
  });

  const factory = process.env.EVM_FACTORY_ADDRESS;
  const implementation = process.env.EVM_IMPLEMENTATION_ADDRESS;
  const fallbackRpc = process.env.EVM_RPC_URL;
  for (const c of EVM) {
    const rpc = process.env[c.rpcEnv] ?? fallbackRpc;
    const chain = await prisma.chain.upsert({
      where: { namespace_reference: { namespace: "eip155", reference: c.reference } },
      update: {},
      create: {
        namespace: "eip155",
        reference: c.reference,
        name: c.name,
        nativeSymbol: c.nativeSymbol,
        decimals: 18,
        rpcUrls: rpc ? [rpc] : [],
        isTestnet: true,
        isActive: true,
      },
    });
    if (factory) {
      await prisma.chainContract.upsert({
        where: { chainId_type: { chainId: chain.id, type: "factory" } },
        update: {},
        create: { chainId: chain.id, type: "factory", address: factory, versionLabel: "v1" },
      });
    }
    if (implementation) {
      await prisma.chainContract.upsert({
        where: { chainId_type: { chainId: chain.id, type: "account_implementation" } },
        update: {},
        create: { chainId: chain.id, type: "account_implementation", address: implementation, versionLabel: "v1" },
      });
    }
  }

  // Stellar testnet row (ANT-709 P1 S1 §5: AC5.5–AC5.8, testnet-only).
  // Keyed by the F1 network_id hex (OQ-S1 proposed; 64-char, deterministic,
  // already bound in every v2 digest). No schema migration: pure data-row
  // expand; chain_accounts FKs by id so existing solana/eip155 rows are
  // untouched (AC5.8 cross-row isolation). Re-runnable via natural-key upsert.
  const stellar = await prisma.chain.upsert({
    where: { namespace_reference: { namespace: STELLAR_NAMESPACE, reference: STELLAR_TESTNET_REFERENCE } },
    update: {},
    create: {
      namespace: STELLAR_NAMESPACE,
      reference: STELLAR_TESTNET_REFERENCE,
      name: "stellar-testnet",
      nativeSymbol: "XLM",
      decimals: 7,
      rpcUrls: [process.env.STELLAR_TESTNET_RPC ?? STELLAR_TESTNET_RPC],
      explorerUrl: STELLAR_TESTNET_EXPLORER,
      isTestnet: true,
      isActive: true,
    },
  });
  // AC5.7: one `factory`-type contract = the §1 deployed factory address.
  // Bootstrap from env `STELLAR_FACTORY_ADDRESS` (filled post-deploy; row
  // seeds without a contract until then). Re-seed heals rotations
  // (update: address) while solana + eip155 rows are byte-unchanged (AC5.8,
  // ANT-70 heal-precedent). No `program`-type row is required for stellar.
  const stellarFactory = process.env.STELLAR_FACTORY_ADDRESS;
  if (stellarFactory) {
    await prisma.chainContract.upsert({
      where: { chainId_type: { chainId: stellar.id, type: "factory" } },
      update: { address: stellarFactory },
      create: { chainId: stellar.id, type: "factory", address: stellarFactory, versionLabel: "v1" },
    });
  }
  console.log("chain registry seeded");

  // Chain logos (one file per chain in Wasabi; rows point at the API proxy).
  // Only fills blanks — a manually set logoUrl is never overwritten.
  const apiBase = (process.env.API_URL ?? "http://localhost:3300").replace(/\/+$/, "");
  for (const c of await prisma.chain.findMany({ where: { logoUrl: null } })) {
    const key = `public/chains/${c.namespace}-${c.reference.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}.png`;
    await prisma.chain.update({
      where: { id: c.id },
      data: { logoUrl: `${apiBase}/v1/tokens/logo?key=${encodeURIComponent(key)}` },
    });
  }

  // Curated token registry: Token holds metadata once, deployments hang one
  // token off many chains (chainId FK → chains.id). Logos live once per
  // symbol at public/tokens/<SYMBOL>.png.
  const TOKENS: { symbol: string; name: string; deployments: { reference: string; mint: string; decimals: number; pinned: boolean; order: number }[] }[] = [
    {
      symbol: "wSOL", name: "Wrapped SOL",
      deployments: [
        { reference: SOLANA_DEVNET_REFERENCE, mint: "So11111111111111111111111111111111111111112", decimals: 9, pinned: false, order: 1 },
        { reference: SOLANA_TESTNET_REFERENCE, mint: "So11111111111111111111111111111111111111112", decimals: 9, pinned: false, order: 1 },
      ],
    },
    {
      symbol: "USDC", name: "USD Coin",
      deployments: [
        { reference: SOLANA_TESTNET_REFERENCE, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, pinned: true, order: 0 },
      ],
    },
    {
      symbol: "USDT", name: "Tether",
      deployments: [
        { reference: SOLANA_DEVNET_REFERENCE, mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, pinned: false, order: 2 },
        { reference: SOLANA_TESTNET_REFERENCE, mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, pinned: false, order: 2 },
      ],
    },
  ];
  for (const t of TOKENS) {
    const token = await prisma.token.upsert({
      where: { symbol: t.symbol },
      update: { name: t.name },
      create: { symbol: t.symbol, name: t.name, logoKey: `public/tokens/${t.symbol}.png` },
    });
    for (const d of t.deployments) {
      const chain = await prisma.chain.findUnique({
        where: { namespace_reference: { namespace: SOLANA_NAMESPACE, reference: d.reference } },
      });
      if (!chain) continue;
      const existing = await prisma.tokenDeployment.findFirst({ where: { tokenId: token.id, chainId: chain.id } });
      if (existing) continue;
      await prisma.tokenDeployment.create({
        data: {
          tokenId: token.id,
          chainId: chain.id,
          mint: d.mint,
          decimals: d.decimals,
          isVisible: true,
          isPinned: d.pinned,
          sortOrder: d.order,
        },
      });
    }
  }
  console.log("token registry seeded");

  // Chain fee-policy v2 bootstrap (ANT-730, spec ANT-727 §4.2). v1 (pure 50%,
  // zero minima, inactive — v1 traffic keeps v1 math) + v2 (spec minima,
  // active). Re-runnable: policies upsert by version with `update: {}` and
  // ANT-743: pure percentage — no minima are seeded. Legacy `chain_min_fees`
  // rows on existing databases are inert (the fee service never reads them);
  // a re-seed never creates or clobbers minima legs. OQ-1: FX display source
  // is CoinGecko USD/IDR as of 2026-10-27 (reference that day ≈ Rp18.110/USD
  // mid-market; BI sell 18.137 / buy 17.957), replacing the static Rp16.000
  // assumption — the rupiah figure stays informational, settlement is base
  // units on-chain.
  await prisma.chainFeePolicy.upsert({
    where: { version: 1 },
    update: {},
    create: { version: 1, bps: 5000, active: false, fxSource: "FALLBACK_STATIC" },
  });
  await prisma.chainFeePolicy.upsert({
    where: { version: 2 },
    update: {},
    create: {
      version: 2,
      bps: 5000,
      active: true,
      fxSource: "CoinGecko USD/IDR",
      fxAsOf: new Date("2026-10-27T00:00:00Z"),
    },
  });
  // No minima rows are seeded or removed: legacy rows stay untouched (inert)
  // and a later cleanup migration may drop the table.
  console.log("chain fee policy seeded (pure percentage, no minima)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
