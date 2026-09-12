// One-time chain-registry bootstrap from current env/code. Safe to re-run
// (upserts by natural key). Run: `pnpm --filter @peridotvault/pid-api db:seed`
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EVM = [
  { reference: "10143", name: "monad-testnet", nativeSymbol: "MON", rpcEnv: "EVM_RPC_URL_10143" },
  { reference: "97", name: "bsc-testnet", nativeSymbol: "tBNB", rpcEnv: "EVM_RPC_URL_97" },
  { reference: "421614", name: "arbitrum-sepolia", nativeSymbol: "ETH", rpcEnv: "EVM_RPC_URL_421614" },
  { reference: "84532", name: "base-sepolia", nativeSymbol: "ETH", rpcEnv: "EVM_RPC_URL_84532" },
];

async function main(): Promise<void> {
  const solanaRef = process.env.SOLANA_CHAIN_REFERENCE ?? "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
  await prisma.chain.upsert({
    where: { namespace_reference: { namespace: "solana", reference: solanaRef } },
    update: {},
    create: {
      namespace: "solana",
      reference: solanaRef,
      name: process.env.SOLANA_NETWORK === "mainnet-beta" ? "solana-mainnet" : "solana-devnet",
      nativeSymbol: "SOL",
      decimals: 9,
      rpcUrls: [process.env.PID_SOLANA_RPC_URL ?? "https://api.devnet.solana.com"],
      explorerUrl: "https://explorer.solana.com",
      isTestnet: process.env.SOLANA_NETWORK !== "mainnet-beta",
      isActive: true,
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
