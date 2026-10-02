import { redirect } from 'next/navigation';

/// /signup is retired: every sign-in goes through the sign-in dialog at /signin (14a), which also shows the one-time
/// beta notice on an account's first sign-in. Old links, bookmarks and the remaining legacy components land there,
/// with their query string kept (campaign tags included). Codex S4 r1.
export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const qs = params.toString();
  redirect(qs ? `/signin?${qs}` : '/signin');
}
