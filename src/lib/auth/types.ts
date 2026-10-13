// Auth types shared by server and browser code (no runtime imports).

export interface User {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  email_confirmed_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

export interface Session {
  user: User;
}

export interface AuthError {
  message: string;
  code: string;
  status: number;
}

export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | "TOKEN_REFRESHED";

export interface AuthApi {
  getUser(): Promise<{ data: { user: User | null }; error: AuthError | null }>;
  getSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }>;
  onAuthStateChange(cb: (event: AuthChangeEvent, session: Session | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  signInWithPassword(creds: { email: string; password: string }): Promise<{
    data: { user: User | null; session: Session | null };
    error: AuthError | null;
  }>;
  signUp(input: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string };
  }): Promise<{ data: { user: User | null; session: Session | null }; error: AuthError | null }>;
  signOut(opts?: { scope?: "global" | "local" | "others" }): Promise<{ error: AuthError | null }>;
  updateUser(attrs: {
    email?: string;
    password?: string;
    /** Verified server-side when present. */
    current_password?: string;
    data?: Record<string, unknown>;
  }): Promise<{
    data: { user: User | null };
    error: AuthError | null;
  }>;
  resetPasswordForEmail(
    email: string,
    opts?: { redirectTo?: string },
  ): Promise<{ data: { mailEnabled: boolean } | null; error: AuthError | null }>;
}
