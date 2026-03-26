# IPTV 429 Validation Checklist (20 Minutes)

Use this to prove whether GoTVH app behavior is contributing to provider rate limits, or if bans are driven by server/provider settings.

## 1. Prep (2 minutes)
- [ ] Close all GoTVH tabs/devices except one browser tab.
- [ ] Stop external EPG/logo/meta helper jobs temporarily.
- [ ] Start live TVHeadend log tail.
- [ ] Record baseline timestamp.

## 2. TVHeadend Safe Mode (3 minutes)
- [ ] Set IPTV playlist refresh to 24h.
- [ ] Limit max simultaneous subscriptions to 1.
- [ ] Set retry/reconnect delay to >= 10s.
- [ ] Use exponential retry backoff (10s, 20s, 40s, 80s).
- [ ] Disable aggressive auto logo/metadata refresh.
- [ ] Save and restart TVHeadend once.

## 3. Test A: Idle Check (3 minutes)
- [ ] Keep GoTVH closed for 3 minutes.
- [ ] Watch logs for provider 429 events.
- [ ] Watch logs for repetitive provider endpoint hits.

Pass criteria:
- [ ] No 429 while idle.

## 4. Test B: App Load Only (4 minutes)
- [ ] Open one GoTVH tab to Home.
- [ ] Wait 2 minutes with no interaction.
- [ ] Open Channels once.
- [ ] Wait 2 minutes.

Pass criteria:
- [ ] No recurring request burst every ~30s.
- [ ] No new 429 events.

## 5. Test C: Single Playback (4 minutes)
- [ ] Start one live stream and watch for 3 minutes.
- [ ] Do not channel hop.
- [ ] Stop playback and wait 1 minute.

Pass criteria:
- [ ] No 429 during single-stream playback.
- [ ] No reconnect loop churn.

## 6. Test D: Controlled Stress (4 minutes)
- [ ] Channel hop slowly: one change every 20-30s.
- [ ] Limit to 5 total changes.
- [ ] Stop immediately at first 429.
- [ ] Record exact action and timestamp of first 429.

Pass criteria:
- [ ] If 429 appears only here, limit is likely provider rate/concurrency policy.

## 7. Decision Matrix
- If 429 appears in Test A: not GoTVH UI; likely server helper or provider-side polling.
- If 429 appears first in Test B: app startup/request pattern likely needs throttling.
- If 429 appears only in Test C/D: provider stream rate/concurrency is the primary issue.
- If no 429 in all tests: previous bans were likely caused by old aggressive settings, multiple clients, or parallel helpers.

## 8. App-Focused Follow-ups (if Test B/C fails)
- [ ] Add debounce/throttle for guide/channel refresh triggers.
- [ ] Verify no periodic polling loops on Home/Channels/Guide.
- [ ] Ensure single active player session guard.
- [ ] Add retry backoff for failed stream attempts.

## 9. Provider-Friendly Baseline
- [ ] One active stream max.
- [ ] Playlist refresh once daily.
- [ ] Metadata/logo auto-refresh off for first 24h.
- [ ] No manual reload spam.
- [ ] Re-enable one feature at a time and monitor logs.

## Logging Template
Use this quick table while testing:

| Time | Test Step | Action | Provider Response | TVH Log Snippet |
|---|---|---|---|---|
| HH:MM:SS | A/B/C/D | e.g., Open Channels | e.g., 200 / 429 | short excerpt |
