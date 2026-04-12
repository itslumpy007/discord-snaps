# Discord Snaps 2.0

Discord Snaps 2.0 turns the bot into a persistent, modular drop system instead of a single in-memory script.

## What's new

- Persistent guild config, active drops, and member stats in `data/state.json`
- Modular app structure under `src/`
- Scheduled daily drops with a configurable local-time window and timezone
- Manual drop start and early-close commands
- Per-drop thread flow for submissions
- On-time, late, missed, and streak tracking
- Reminder automation, weekly recap posts, reward-role support, and JSON exports
- Integrated admin dashboard with Discord OAuth, server controls, and exports

## Commands

- `/snapsetup` configures the snap channel and ping role
- `/snapwindow` sets the local schedule window and drop duration
- `/snaptimezone` sets the server timezone
- `/snapreminders` configures reminder timings
- `/snaptoggle` enables or disables automatic drops
- `/snapdrop` starts a drop immediately
- `/snapclose` closes the current drop
- `/snapextend` extends the current drop
- `/snapreopen` reopens the most recently closed drop
- `/snapreroll` rerolls the next automatic drop
- `/snaprewardrole` configures an optional reward role
- `/snapconfig` shows current server settings
- `/snapstats` shows member stats
- `/snapleaderboard` shows server leaders
- `/snapsnooze` marks yourself snoozed for the active drop
- `/snapexport` exports guild data as JSON
- `/snaprecap` posts a recap immediately

## Dashboard

The dashboard is served by the bot process when these environment variables are set:

- `DISCORD_CLIENT_SECRET`
- `DASHBOARD_SESSION_SECRET`
- `DASHBOARD_REDIRECT_URI`
- Optional: `DASHBOARD_HOST`
- Optional: `DASHBOARD_PORT`
- Optional: `DASHBOARD_PUBLIC_URL`

After login with Discord, the dashboard lets you:

- View manageable guilds where the bot is present
- Inspect server health, next drop timing, live drop status, and leaderboard data
- Update channel, roles, timezone, schedule, reminders, reward-role settings, and recap toggles
- Start, close, extend, reopen, reroll, and recap from the browser
- Download a guild JSON export

## Notes

- Keep `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in `.env`
- Add `DISCORD_CLIENT_SECRET` plus the dashboard variables above to enable the admin dashboard
- The bot registers commands per guild once a guild exists in state
- Existing state data is reused where possible and expanded by the new store layer
- Use `npm run check` for syntax validation and `npm test` for core scheduling/state tests
