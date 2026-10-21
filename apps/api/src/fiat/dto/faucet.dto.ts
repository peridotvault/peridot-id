import { IsOptional } from "class-validator";

/**
 * Sandbox faucet request (ANT-287 FR-2).
 *
 * Deliberately constraint-free: every boundary check (null, missing,
 * zero, negative, non-integer, over per-call max) is enforced in
 * `FiatLedgerService.mintTestCredit`, which throws 422. DTO-level
 * validators would surface as 400 via the global ValidationPipe; the
 * contract mandates 422 for all invalid amounts. `@IsOptional` exists
 * only so `whitelist: true` keeps the property instead of stripping it.
 */
export class TestCreditDto {
  @IsOptional()
  amountMinor!: unknown;
}
