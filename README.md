# Black Bull Pulse

Simple Vercel + Supabase + X bot for `$ANSEM` price replies, user alerts, and an hourly public pulse.

## Setup

1. Create a Supabase project.
2. Run `supabase.sql` in the Supabase SQL editor.
3. Create a Vercel project from this folder.
4. Add the variables from `.env.example` to Vercel.
5. Deploy.
6. Create a cron-job.org job that calls:

```txt
https://your-vercel-app.vercel.app/api/tick?secret=YOUR_CRON_SECRET
```

Run it every 1 minute. The bot only posts the public pulse once per hour.

## Commands

```txt
@BlackBullPulse price
@BlackBullPulse $ANSEM?
@BlackBullPulse alert above 0.12
@BlackBullPulse alert below 0.08
@BlackBullPulse alert mcap above 10m
@BlackBullPulse alert market cap below 8m
@BlackBullPulse alert mc above 10m
@BlackBullPulse alert fdv below 20m
@BlackBullPulse alert fully diluted valuation above 25m
@BlackBullPulse alert me when $ANSEM gets to 141m fdv
@BlackBullPulse alert me when $ANSEM hits 150m market cap
@BlackBullPulse notify me when $ANSEM reaches 0.20
@BlackBullPulse alerts
@BlackBullPulse cancel
```

## Notes

- Duplicate active alerts are blocked in code and with a partial unique index.
- Processed tweet IDs are stored to reduce duplicate replies on serverless retries.
- Public price posts are hourly, not every minute.
- A significant move pulse posts when `$ANSEM` rises at least 20% from the last stored signal baseline.
- Alerts can target price, market cap, or FDV. Supported short forms include `mcap`, `mc`, and `fdv`.
- Natural phrases like `gets to`, `hits`, and `reaches` infer `above` or `below` from the current value.
