// Single source of truth for well-known chain references. The chains registry
// (seed + admin API) must contain matching rows — chain_accounts has a hard FK
// to chains(namespace, reference), so these constants and the seed must agree.
export const SOLANA_NAMESPACE = "solana";
export const EIP155_NAMESPACE = "eip155";
export const SOLANA_MAINNET_REFERENCE = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
export const ACCOUNT_TYPE_SMART = "smart_account";
export const ACCOUNT_TYPE_LINKED = "linked_address";
