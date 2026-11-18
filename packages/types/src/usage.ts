/**
 * Web3 usage reporting for one registered app in one UTC month (`YYYY-MM`).
 * Reporting-only: reaching the allowance never charges and never blocks.
 */
export interface UsageReport {
  appClientId: string;
  month: string;
  /** Distinct PIDs counted this month. */
  activePids: number;
  /** Of those, first-party logins — never billable. */
  firstPartyPids: number;
  /** PIDs that would count against the allowance. */
  billablePids: number;
  freeAllowance: number;
  /** Reported only — nothing is charged, nothing is cut off. */
  overagePids: number;
  billing: "reporting-only";
}
