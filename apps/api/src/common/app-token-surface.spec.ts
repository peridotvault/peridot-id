// App-token write surface guard (ANT-233 F1 residual). Fail-closed CI check:
// every state-changing route (POST/PUT/PATCH/DELETE) carrying JwtAuthGuard
// must also carry UserTokenGuard (user-session-only) or AdminGuard (which
// rejects `app` tokens itself) — unless it is on the explicit intentional
// allowlist below with a documented reason. Add a new write route without a
// guard and this test fails until you either guard it or justify the allowlist
// entry. Reads (GET/HEAD) are intentionally app-readable (owner-bound) and
// unchecked; routes without JwtAuthGuard (public login flows, webhooks) are
// out of scope for this check.
import { GUARDS_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { AccountController } from "../account/account.controller";
import { AdminController } from "../admin/admin.controller";
import { AuthController } from "../auth/auth.controller";
import { PidAppsController } from "../auth/apps.controller";
import { ChainController } from "../chain/chain.controller";
import { CredentialController } from "../credentials/credential.controller";
import { FiatController } from "../fiat/fiat.controller";
import { FiatLedgerController } from "../fiat/fiat-ledger.controller";
import { IdentityController } from "../identity/identity.controller";
import { IntentController } from "../intent/intent.controller";
import { OpenApiController } from "../openapi/openapi.controller";
import { PermissionsController } from "../permissions/permissions.controller";
import { ProfileController } from "../profile/profile.controller";
import { SessionKeysController } from "../session-keys/session-keys.controller";
import { WalletController } from "../wallet/wallet.controller";
import { AdminGuard } from "./admin.guard";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { UserTokenGuard } from "./user-token.guard";

// SponsoredWithdrawService lazily requires pid-solana at runtime; stub it so
// importing WalletController doesn't load the real @solana/web3.js graph.
jest.mock("@peridotvault/pid-solana", () => ({
  Keypair: { fromSecretKey: jest.fn(() => ({ publicKey: { toBase58: () => "relayer" } })) },
  PublicKey: class { toBase58() { return "x"; } },
  SolanaAdapter: jest.fn(),
  SolanaRpc: jest.fn(),
  fromHex: jest.fn((s: string) => Uint8Array.from(Buffer.from(s, "hex"))),
}));

const CONTROLLERS = [
  AccountController,
  AdminController,
  AuthController,
  PidAppsController,
  ChainController,
  CredentialController,
  FiatController,
  FiatLedgerController,
  IdentityController,
  IntentController,
  OpenApiController,
  PermissionsController,
  ProfileController,
  SessionKeysController,
  WalletController,
] as const;

const WRITE_METHODS = new Set([RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE]);

/**
 * Authenticated but intentionally app-token-open. Every entry needs a reason —
 * the test asserts the reason is non-empty so the allowlist cannot grow
 * silently. Fiat transfers are the documented escrow-release path
 * (docs/FIAT_LEDGER.md "Machine auth"); fiat money-in moves no funds out;
 * validators are stateless (no DB writes); deposit sync is the Tobias-blessed
 * corroboration path (ANT-239).
 */
const ALLOWLIST: Record<string, string> = {
  "FiatLedgerController.inquiry": "documented escrow-release path (owner pid spends own funds; 1h TTL bounds theft)",
  "FiatLedgerController.confirm": "documented escrow-release path (owner pid spends own funds; 1h TTL bounds theft)",
  "FiatLedgerController.cancel": "cancel of own unposted intent; same escrow path as inquiry/confirm",
  "FiatController.quoteDeposit": "money-in quote only; moves no funds",
  "FiatController.checkoutDeposit": "money-in initiation (creates DOKU invoice); moves no funds out",
  "FiatController.syncDeposit": "Tobias-blessed corroboration of caller's own pending deposit; moves no other funds",
  "SessionKeysController.validateGrant": "stateless validation; no DB writes",
  "PermissionsController.validateGrant": "stateless validation; no DB writes",
};

describe("app-token write surface (ANT-233 F1)", () => {
  it("every authenticated write route rejects machine tokens unless explicitly allowlisted", () => {
    const violations: string[] = [];
    for (const C of CONTROLLERS) {
      const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, C) ?? [];
      const proto: Record<string, object> = C.prototype as unknown as Record<string, object>;
      for (const key of Object.getOwnPropertyNames(C.prototype)) {
        if (key === "constructor") continue;
        const handler = proto[key];
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined || !WRITE_METHODS.has(method)) continue;
        const guards: unknown[] = [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
        // Only the authenticated surface: routes without JwtAuthGuard (public
        // login flows, webhooks) are out of scope for this check.
        if (!guards.includes(JwtAuthGuard)) continue;
        if (!guards.includes(UserTokenGuard) && !guards.includes(AdminGuard)) {
          const id = `${C.name}.${key}`;
          if (!ALLOWLIST[id]) violations.push(id);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allowlist entry carries a documented reason", () => {
    for (const [id, reason] of Object.entries(ALLOWLIST)) {
      expect(typeof reason === "string" && reason.length > 0).toBe(true);
      void id;
    }
  });
});
