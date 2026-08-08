# KEMRI SACCO Backend

Node/Express backend handling member registration, M-Pesa payments (Daraja), and SMS notifications (Africa's Talking) for KEMRI Co-operative Savings and Credit Society.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```
   cp .env.example .env
   ```
   - Daraja sandbox credentials: https://developer.safaricom.co.ke (create an app, use the test shortcode `174379` and its passkey)
   - Africa's Talking sandbox: https://account.africastalking.com (username `sandbox`, generate an API key)

3. Make sure PostgreSQL is running and `DATABASE_URL` points to it. Tables are created automatically on server start.

4. Run in dev mode:
   ```
   npm run dev
   ```

## Endpoints (v0)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/members` | Register a new member |
| GET | `/api/members/:id` | Get a member by ID |
| GET | `/api/members` | List all members |
| POST | `/api/payments/initiate` | Trigger an STK push for a member |
| POST | `/webhooks/daraja` | Safaricom's payment result callback (not called manually) |
| GET | `/health` | Health check |

## Testing the payment flow locally

Daraja's callback URL needs to be publicly reachable, so for local dev you'll need a tunnel (e.g. `ngrok http 3000`) and set `DARAJA_CALLBACK_URL` to the ngrok URL + `/webhooks/daraja`.

## Not yet built

- USSD (Phase 2 — see project docs)
- Auth/session handling for the web portal
- Input validation beyond basic required-field checks
- Migrations (schema currently just auto-creates via `init()` on boot)
