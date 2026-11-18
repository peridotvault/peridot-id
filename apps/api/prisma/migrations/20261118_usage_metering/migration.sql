-- Web3 usage metering (stage 5 of docs/plan/05). Reporting-only: no rates, no
-- charges, no cutoff. The unique keys are the idempotency mechanism.
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "appClientId" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "firstParty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_monthly" (
    "id" TEXT NOT NULL,
    "appClientId" TEXT NOT NULL,
    "pid" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "firstParty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_monthly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "usage_events_appClientId_pid_month_reason_key" ON "usage_events"("appClientId", "pid", "month", "reason");
CREATE INDEX "usage_events_appClientId_month_idx" ON "usage_events"("appClientId", "month");
CREATE INDEX "usage_events_pid_month_idx" ON "usage_events"("pid", "month");
CREATE UNIQUE INDEX "usage_monthly_appClientId_pid_month_key" ON "usage_monthly"("appClientId", "pid", "month");
CREATE INDEX "usage_monthly_appClientId_month_idx" ON "usage_monthly"("appClientId", "month");
