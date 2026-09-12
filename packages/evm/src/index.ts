// Peridot EVM adapter — CREATE2 counterfactual accounts on top of pid-core.
export {
  accountIdToSalt32,
  addressToBytes,
  buildEvmAuthorizationPayload,
  compressedToX,
  concat,
  deriveEvmSmartAccountAddress,
  DOMAIN_EVM,
  EVM_CHAINS,
  fromAscii,
  fromHex,
  getCreate2Address,
  keccak256,
  minimalProxyInitCode,
  splitRawXy,
  toChecksumAddress,
  toHex,
} from "@peridotvault/pid-core/dist/evm";
export type { Bytes, EvmChain } from "@peridotvault/pid-core/dist/evm";
export { EvmRpc } from "./rpc";
export type { EvmRpcLike } from "./rpc";
export { EvmAdapter } from "./adapter";
