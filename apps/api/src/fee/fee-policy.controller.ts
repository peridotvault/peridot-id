// Public chain fee-policy read — wallets/SDKs discover the quoting policy
// (version, percentage leg, FX display source) here instead of hardcoding
// numbers (spec ANT-727 §4.3/§7.2, AC-18). Public, no auth — same posture as
// the chain registry list. Contract: 200
// `{ version, bps, minFee: {}, fxSource, fxAsOf, updatedAt }`. Settlement is
// always base units on-chain. `minFee` is always empty since ANT-743 (pure
// percentage) and stays so existing clients keep parsing.
import { Controller, Get, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { FeePolicyPublicView, FeePolicyService } from "./fee-policy.service";

@Controller("v1/fee-policy")
@UseGuards(ThrottlerGuard)
export class FeePolicyController {
  constructor(private readonly fees: FeePolicyService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  get(): Promise<FeePolicyPublicView> {
    return this.fees.publicView();
  }
}
