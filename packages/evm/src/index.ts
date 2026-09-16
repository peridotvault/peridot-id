// Peridot EVM adapter — CREATE2 counterfactual accounts on top of pid-core.
export {
  pidToSalt32,
  addressToBytes,
  buildEvmAuthorizationPayload,
  buildEvmAuthorizationPayloadV2,
  buildEvmAuthorizationPayloadV3,
  compressedToX,
  concat,
  deriveEvmSmartAccountAddress,
  DOMAIN_EVM,
  DOMAIN_EVM_V2,
  DOMAIN_EVM_V3,
  EVM_CHAINS,
  fromAscii,
  fromHex,
  getCreate2Address,
  keccak256,
  minimalProxyInitCode,
  OP_EVM,
  splitRawXy,
  toChecksumAddress,
  toHex,
} from "@peridotvault/pid-core/dist/evm";
export type { Bytes, EvmChain } from "@peridotvault/pid-core/dist/evm";
export { EvmRpc } from "./rpc";
export type { EvmRpcLike } from "./rpc";
export { EvmAdapter, buildViewCalldata } from "./adapter";
