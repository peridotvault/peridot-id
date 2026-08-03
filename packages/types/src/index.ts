export interface Identity {
  id: string;
  createdAt: string;
}

export interface Profile {
  displayName: string | null;
  avatarUrl: string | null;
  locale: string | null;
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
  message: string;
}
