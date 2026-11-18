/**
 * Web3 usage reporting for one registered app in one UTC month (`YYYY-MM`).
 *
 * A PID counts once per app per month, however many logins, wallets or login
 * methods it used; the same PID counts separately in another app. `totalPids`
 * covers every app-bound login, `web3Pids` the subset that proved an external
 * wallet — the free allowance applies to that subset only, so Web2-only usage is
 * unlimited and free.
 *
 * Reporting-only: reaching the allowance never charges and never blocks.
 */
export interface UsageReport {
  appClientId: string;
  month: string;
  /** Distinct PIDs with any app-bound login this month. */
  totalPids: number;
  /** Distinct PIDs that proved an external wallet this month. */
  web3Pids: number;
  /** Of the Web3 PIDs, first-party logins — never billable. */
  firstPartyPids: number;
  /** Web3 PIDs that would count against the allowance. */
  billablePids: number;
  freeAllowance: number;
  /** Reported only — nothing is charged, nothing is cut off. */
  overagePids: number;
  billing: "reporting-only";
}
