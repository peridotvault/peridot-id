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
  console.log("chain registry seeded");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
