export type IdentityStatus = "active" | "suspended" | "deleted";

export interface Identity {
  id: string;
  status: IdentityStatus;
  createdAt: string;
}

export interface Profile {
  id: string;
  identityId: string;
  username: string | null;
  usernameChangedAt: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileUpdate {
  username?: string;
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

export interface LoginResponse {
  url: string;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
}
