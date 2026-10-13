// Helpers for recognising Postgres errors thrown through Kysely / pg.

export interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
}

export function pgCode(err: unknown): string | undefined {
  return (err as PgError | null)?.code;
}

/** 23505 — unique constraint. */
export const isUniqueViolation = (err: unknown) => pgCode(err) === "23505";
/** 23503 — foreign key. */
export const isForeignKeyViolation = (err: unknown) => pgCode(err) === "23503";
/** 42501 — insufficient privilege / RLS rejection / RAISE ... USING ERRCODE '42501'. */
export const isPermissionDenied = (err: unknown) => pgCode(err) === "42501";
/** 22023 — invalid parameter value (used by the membership RPCs). */
export const isInvalidParameter = (err: unknown) => pgCode(err) === "22023";
/** 23514 — check constraint. */
export const isCheckViolation = (err: unknown) => pgCode(err) === "23514";

export function pgMessage(err: unknown): string {
  return (err as PgError | null)?.message ?? String(err);
}
