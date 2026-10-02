import { redirect } from 'next/navigation';

/// /profile is retired: sending and receiving USDC live on /wallet, and the account's security (two-factor, key
/// export, sign out) on /settings. Old links and bookmarks land on /wallet.
export default function ProfilePage() {
  redirect('/wallet');
}
