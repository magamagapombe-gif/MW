# MW — Refer & Earn App

Uganda's referral platform built on Supabase + LivePay.me.

## Architecture

- **Frontend:** Single `index.html` (no build step) — deployed on Vercel
- **Database:** Supabase Postgres with Row Level Security
- **Auth:** Supabase Auth (email/password)
- **Backend:** Supabase Edge Functions (Deno)
- **Payments:** LivePay.me API (MTN MoMo + Airtel Money)

## Payment Flow

```
User registers → Edge fn calls LivePay /collect-money →
STK push to phone → User approves → LivePay sends webhook →
Edge fn marks user active + credits referrer UGX 4,000
```

## Fee Structure

| Event | Amount |
|-------|--------|
| Registration fee (paid by new user) | UGX 20,000 |
| Referral bonus (paid to referrer) | UGX 4,000 |
| Minimum withdrawal | UGX 1,000 |

---

# Deployment Guide

## Step 1 — Push to GitHub

From inside this folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/magamagapombe-gif/MW.git
git push -u origin main
```

## Step 2 — Set up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Note your **Project Ref** (the `xxxx` in `xxxx.supabase.co`)
3. Open **SQL Editor** → paste the contents of `schema.sql` → Run
4. Go to **Authentication → Providers → Email** → turn OFF "Confirm email" (for faster testing)
5. Go to **Database → Replication** → enable `profiles` and `transactions` tables for realtime
6. Go to **Settings → API** → copy these two values for later:
   - `Project URL`
   - `anon public` key

## Step 3 — Deploy Edge Functions

Install Supabase CLI and log in:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Set the LivePay secrets (we confirmed these endpoints work):

```bash
supabase secrets set LIVEPAY_API_KEY=your_api_key_from_livepay_dashboard
supabase secrets set LIVEPAY_ACCOUNT_NUMBER=LP2604221401
```

Deploy all three functions:

```bash
supabase functions deploy collect-payment
supabase functions deploy withdraw
supabase functions deploy livepay-webhook --no-verify-jwt
```

> The `--no-verify-jwt` on the webhook matters — LivePay's server doesn't send a Supabase JWT.

## Step 4 — Register the Webhook in LivePay

1. Your webhook URL will be:
   ```
   https://YOUR_PROJECT_REF.supabase.co/functions/v1/livepay-webhook
   ```
2. In your LivePay dashboard, find the Webhooks section and paste this URL
3. LivePay should give you a **webhook secret** — copy it
4. Set it as a Supabase secret:
   ```bash
   supabase secrets set LIVEPAY_WEBHOOK_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/livepay-webhook
   supabase secrets set LIVEPAY_WEBHOOK_SECRET=the_secret_livepay_gave_you
   ```
5. Redeploy the webhook so it picks up the new secrets:
   ```bash
   supabase functions deploy livepay-webhook --no-verify-jwt
   ```

> If LivePay doesn't give a webhook secret, leave those two secrets unset and the webhook will skip signature verification (less secure but still functional — add a support ticket with LivePay to enable signing).

## Step 5 — Configure the Frontend

Open `index.html`, find lines 871–872 and replace the placeholders:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'your_anon_public_key';
```

Commit and push:

```bash
git add index.html
git commit -m "Configure Supabase credentials"
git push
```

## Step 6 — Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New** → **Project**
2. Import your `magamagapombe-gif/MW` repo from GitHub
3. Framework Preset: **Other** (it's a static site)
4. Root Directory: leave as `./`
5. Build Command: leave empty
6. Output Directory: leave empty
7. Click **Deploy**

You're live at `https://mw-xxx.vercel.app`.

## Step 7 — Test the Full Flow

1. Open your Vercel URL
2. Sign up with a real email
3. Complete the registration form with a phone number you control
4. Approve the UGX 20,000 prompt on that phone
5. Within a few seconds, the webhook should fire and you'll see your account activated on the dashboard

If it doesn't work, check **Supabase → Edge Functions → Logs** for each function.

---

# Security Notes

- `LIVEPAY_API_KEY` is **only** in Supabase Edge Function secrets — never exposed to the frontend
- `SUPABASE_SERVICE_ROLE_KEY` is automatically available inside Edge Functions and never sent to the browser
- All frontend calls to edge functions include the user's Supabase auth token, which the edge function verifies
- RLS policies ensure users can only see their own profile and transactions
- Withdrawals check for an existing pending withdrawal before initiating a new one
- Balance is deducted atomically via the `increment_balance` Postgres function

---

# Edge Function URLs (after deploy)

| Function | URL |
|----------|-----|
| collect-payment | `https://PROJECT.supabase.co/functions/v1/collect-payment` |
| withdraw | `https://PROJECT.supabase.co/functions/v1/withdraw` |
| livepay-webhook | `https://PROJECT.supabase.co/functions/v1/livepay-webhook` |

---

# LivePay Endpoints Used

| Purpose | Method | URL |
|---|---|---|
| Collect from customer | POST | `https://livepay.me/api/collect-money` |
| Send to recipient | POST | `https://livepay.me/api/send-money` |
| Check balance | GET | `https://livepay.me/api/check-balance` |
| Transaction status | GET | `https://livepay.me/api/transaction-status` |
| Webhook | POST (from LivePay) | Your Supabase function |

All endpoints use `Authorization: Bearer YOUR_API_KEY` — a single key is sufficient.
