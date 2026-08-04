export interface Identity {
  id: string;
  createdAt: string;
}

export interface Profile {
  id: string;
  identityId: string;
  displayName: string | null;
  avatarUrl: string | null;
  locale: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileUpdate {
  displayName?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
}

export interface LoginResponse {
  url: string;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
}
