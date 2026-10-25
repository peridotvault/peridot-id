export { PeridotWallet, ClusterMismatchError, assertChainEcho, buildChainEcho } from "./wallet/wallet-client.js";
export type { PeridotWalletOptions } from "./wallet/wallet-client.js";
export type { ExecuteInput, ExecuteMetaInput, RotateInput, TopupInput, WithdrawInput, ChainEcho, FeeQuoteView, SubmitTransactionInput } from "./wallet/wallet-client.js";
export {
  AUTHORIZATION_TTL_SECS,
  FeeApprovalDeniedError,
  QUOTE_TTL_SECS,
  SOLANA_DECIMALS,
  classifyFeeFailure,
  coversBalance,
  formatFeeAmount,
  normalizeFeeQuote,
  shortfallBaseUnits,
  shortfallMessage,
  ttlRemainingMs,
} from "./wallet/fee-quote.js";
export type { FeeApprovalHandler, FeeFailure, FeeFailureAction, FeeQuoteV2, NormalizedFeeQuote } from "./wallet/fee-quote.js";
export {
  PeridotFiat,
  sumTransferFee,
  type CheckoutDepositView,
  type DepositQuoteView,
  type PaymentMethodQuote,
  type TransferFeeParts,
  type FeePolicyView,
  type FiatBalanceView,
  type FiatDepositView,
  type FiatLedgerEntry,
  type FiatLedgerView,
  type FiatTransferInput,
  type FiatTransferInquiryView,
  type TestCreditView,
} from "./fiat/fiat-client.js";
export type { ActivationView, ActivationStatus } from "./wallet/wallet-client.js";
export { PeridotLevel } from "./level.js";
export { authenticatePasskey, BrowserPasskeySigner, PasskeyHostedRequiredError, registerPasskey } from "@peridotvault/pid-core";
export type { PasskeySigner } from "@peridotvault/pid-core";
export {
  awaitPopupRequest,
  forwardPopupLoginCode,
  openLoginPopup,
  openLoginTab,
  openPeridotPopup,
  parsePopupOrigin,
  postPopupReady,
  postPopupResult,
  readPopupParams,
  PopupBlockedError,
  PopupClosedError,
  PopupUnavailableError,
} from "./popup.js";
export type { PopupParams, PopupResult } from "./popup.js";
export { EMBED_LOGIN, EMBED_READY, EMBED_TOKEN, EmbedBridge, readEmbedParams } from "./embed.js";
export type { EmbedParams } from "./embed.js";
export { FeePayerManager, type SecretStore } from "@peridotvault/pid-core";
export { LocalHistoryStore, type HistoryStore } from "@peridotvault/pid-core";

export * from "./env.js";
export * from "./auth-client.js";
export * from "./identity-client.js";
export * from "./profile-client.js";
export * from "./passkey-client.js";
export * from "./admin-client.js";
export { Peridot, PeridotClient, type PeridotOptions } from "./client.js";
export { Peridot as default } from "./client.js";
export type {
  ApiError,
  Authority,
  Chain,
  ChainContract,
  ChainPreview,
  CreateChainInput,
  CreateTokenInput,
  ExchangeResult,
  Identity,
  IdentityCredential,
  LevelSummary,
  LoginResponse,
  Profile,
  ProfileUpdate,
  RegistryToken,
  Role,
  Session,
  SsoGrant,
  Token,
  TokenDeployment,
  TokenDeploymentInput,
  TokenPreview,
  UpdateChainInput,
  UpdateTokenDeploymentInput,
  UpdateTokenInput,
  UpsertContractInput,
} from "@peridotvault/pid-types";
