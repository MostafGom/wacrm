// Service-role client for the ai engine. RLS is bypassed — every
// query must scope by account_id itself. Shared implementation:
// src/lib/db/admin.ts.
export { supabaseAdmin } from '@/lib/db/admin'
