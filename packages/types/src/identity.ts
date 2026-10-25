export type IdentityStatus = "active" | "suspended" | "deleted";

export type Role = "user" | "admin";

export interface Identity {
  /** Permanent PID: `<handle>@pid`. Immutable, never reused. */
  pid: string;
  status: IdentityStatus;
  role?: Role;
  createdAt: string;
}

/** Permanent ecosystem identity: `<handle>@pid` (e.g. `ifal@pid`).
 *  User-chosen once, immutable, never reused or reassigned. */
export type Pid = `${string}@pid`;

export interface Profile {
  /** Shared PK with Identity — strict 1:1, the value IS the PID. */
  pid: string;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string | null;
  /**
   * Authoritative level summary, read live from PeridotID (ANT-89 M1).
   * Optional for back-compat; apps must NOT persist it — no XP duplication
   * in app DBs, re-read it instead.
   */
  level?: LevelSummary;
  createdAt: string;
  updatedAt: string;
}

/** Wire shape of GET /v1/users/{pid}/level (snake_case). */
export interface LevelSummary {
  pid: string;
  level: number;
  total_xp: number;
  current_level_xp: number;
  /** Null at the max-level cap. */
  next_level_xp: number | null;
  progress_percentage: number;
}

export interface ProfileUpdate {
  displayName?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
}

export interface IdentityCredential {
  id: string;
  provider: string;
  email: string | null;
  linkedAt: string;
  lastLoginAt: string | null;
}

/** One identity signed into this browser (wallet account switcher). */
export interface AccountView {
  pid: string;
  displayName: string | null;
  avatarUrl: string | null;
  isActive: boolean;
}

/** Pending post-auth PID claim (verified credential, no identity yet). */
export interface ClaimStatus {
  pending: boolean;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}
