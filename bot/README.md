# Test Discord bridge

This bot is intentionally restricted to the isolated test guild:
- Guild: 1569044247208923291
- Channels: 1569054230138978415 (cases), 1569054925122699417 (meetings)

It does not read or post in the production guild.

## Render environment variables
- `DISCORD_BOT_TOKEN`: add privately in Render Environment.
- `WORKER_INGEST_URL`: `https://arab-city-justice.mohamed2y2y2g.workers.dev/api/bot/messages`
- `BOT_INGEST_SECRET`: same secret configured on the Cloudflare Worker as a secret.

Enable the Message Content Intent in the Discord Developer Portal. Grant only View Channels and Read Message History / View Channel permissions for the two test channels. Do not grant Administrator.

The bridge forwards plain text only. Attachments, embeds, edits, deletes, voice, and commands are not mirrored by this initial version.
