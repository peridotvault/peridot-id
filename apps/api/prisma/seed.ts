// One-time chain-registry bootstrap. Safe to re-run (upserts by natural key).
// Chains/RPC/contracts live in the DB and are edited in the workspace admin —
// no Solana chain/RPC/program env. Run: `pnpm --filter @peridotvault/pid-api db:seed`
import { PrismaClient } from "@prisma/client";
import {
  SOLANA_DEVNET_RPC,
  SOLANA_MAINNET_REFERENCE,
  SOLANA_NAMESPACE,
  SOLANA_PROGRAM_ID,
} from "../src/common/chains";

const prisma = new PrismaClient();

const EVM = [
  { reference: "10143", name: "monad-testnet", nativeSymbol: "MON", rpcEnv: "EVM_RPC_URL_10143" },
  { reference: "97", name: "bsc-testnet", nativeSymbol: "tBNB", rpcEnv: "EVM_RPC_URL_97" },
  { reference: "421614", name: "arbitrum-sepolia", nativeSymbol: "ETH", rpcEnv: "EVM_RPC_URL_421614" },
  { reference: "84532", name: "base-sepolia", nativeSymbol: "ETH", rpcEnv: "EVM_RPC_URL_84532" },
];

async function main(): Promise<void> {
  // The account-creation path writes SOLANA_MAINNET_REFERENCE (common/chains.ts) —
  // the chain_accounts FK requires this row to exist. Admin edits RPC/contracts later.
  const solana = await prisma.chain.upsert({
    where: { namespace_reference: { namespace: SOLANA_NAMESPACE, reference: SOLANA_MAINNET_REFERENCE } },
    update: {},
    create: {
      namespace: SOLANA_NAMESPACE,
      reference: SOLANA_MAINNET_REFERENCE,
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
    update: {},
    create: { chainId: solana.id, type: "program", address: SOLANA_PROGRAM_ID, versionLabel: "v1" },
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
