# MW — Refer & Earn (final build)

Stack: Vercel (static `index.html`) + Supabase (Postgres + Auth + Edge Functions) + LivePay.me (mobile money).

Live: https://mwm-five.vercel.app

## What's in this folder

```
.
├── index.html                              ← the entire frontend
├── vercel.json                             ← Vercel config
├── .gitignore
├── schema.sql                              ← initial schema (already applied)
├── migration-phase1.sql                    ← already applied
├── migration-phase4.sql                    ← already applied
├── migration-phase5.sql                    ← already applied
└── supabase/functions/
    ├── collect-payment/index.ts            ← registration UGX 20,000
    ├── deposit/index.ts                    ← user deposit to wallet
    ├── withdraw/index.ts                   ← per-category withdrawal w/ 5% fee
    ├── purchase-vault/index.ts             ← buy a vault plan
    ├── complete-task/index.ts              ← finish a daily task
    └── livepay-webhook/index.ts            ← LivePay status callbacks
```

## Before pushing — paste your anon key into index.html

Open `index.html`, find:
```js
const SUPABASE_ANON_KEY = 'PASTE_YOUR_ANON_KEY_HERE';
```
Replace with your real anon key from Supabase → Settings → API.

## Push to GitHub

From inside this folder, in a terminal:

```bash
git add .
git commit -m "Final build: phases 1-5"
git push
```

If git complains about diverged history, run:
```bash
git push --force-with-lease
```

Vercel auto-redeploys mwm-five within ~30s. Hard-refresh the site (Ctrl+Shift+R) to see the new build.

## Edge functions are already deployed

You've already deployed all six. If you ever need to redeploy:

```bash
npx supabase functions deploy collect-payment --no-verify-jwt
npx supabase functions deploy deposit         --no-verify-jwt
npx supabase functions deploy withdraw        --no-verify-jwt
npx supabase functions deploy purchase-vault  --no-verify-jwt
npx supabase functions deploy complete-task   --no-verify-jwt
npx supabase functions deploy livepay-webhook --no-verify-jwt
```

## Required Supabase secrets (already set)

```
LIVEPAY_API_KEY=...
LIVEPAY_ACCOUNT_NUMBER=LP2604221401
LIVEPAY_WEBHOOK_URL=https://lwzupqjsnhgimhclxsyg.supabase.co/functions/v1/livepay-webhook
LIVEPAY_WEBHOOK_SECRET=...   (optional — only if LivePay gave you one)
```

## SQL files

The 4 SQL files are kept here for reference. They're already applied to your live database; you only need to re-run any of them on a fresh Supabase project.

Run order:
1. `schema.sql`
2. `migration-phase1.sql`
3. `migration-phase4.sql`
4. `migration-phase5.sql`

Phase 2 and 3 didn't add new SQL.

## Features implemented

- ✅ Email/password auth with Supabase
- ✅ Multi-step registration (phone + network + referral)
- ✅ UGX 20,000 activation via LivePay
- ✅ 7-section dashboard: Home, Vault, Tasks, Wallet, Profile, Referrals (via Home), SACCO (via Home)
- ✅ Bottom navigation, mobile-first
- ✅ 4 earning categories: deposit balance, referral, task, sacco
- ✅ Deposit flow (LivePay collect → webhook credits balance)
- ✅ Withdraw with category selector, 5% admin fee, Fri/Sat task rule
- ✅ 11 vault plans + Early Bird, purchase from wallet balance
- ✅ 10% referral bonus on referred users' vault purchases
- ✅ Daily task engine with timer, plan-gating, daily quota
- ✅ SACCO investments with maturity countdown, Monday-only withdrawal
- ✅ Referral career tiers (5 levels) + monthly salary display
- ✅ Weekly leaderboard
- ✅ Activate-first gating on Vault/Tasks/SACCO/Deposit/Withdraw
