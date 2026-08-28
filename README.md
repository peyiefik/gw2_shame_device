# GW2 Shame Device

A static GitHub Pages toy that turns Guild Wars 2 `dps.report` encounter logs into a deliberately unserious raid awards ceremony.

## What it does

- Accepts multiple `dps.report` / `b.dps.report` encounter links.
- Fetches Elite Insights JSON directly from `dps.report/getJson` in the browser.
- Merges players across the whole raid night by GW2 account name.
- Generates dynamic awards for deaths, downs, DPS, breakbar damage, resurrects, cleanses, boon strips, incoming damage, commander distance, cast activity, and Elite Insights mechanic appearances.
- Can include or exclude wipes.
- Includes a demo raid night so the interface can be tested without any logs.
- Copies a Discord-friendly awards summary.
- Requires no backend, API key, user token, or build step.

## GitHub Pages

This repository is plain HTML/CSS/JavaScript. In repository settings, enable **Pages** and deploy from the `main` branch root.

## Data / privacy

The page runs entirely in the browser. Report JSON is fetched from dps.report and is not sent to another service by this app.

Do **not** add a dps.report user token to this project. It is not needed for analyzing public report links.

## Notes on mechanics

Elite Insights mechanics are not universally “mistakes.” Some are informational or encounter-specific. The app therefore treats mechanic counts as comedy-oriented “appearances,” weighted by the severity value provided by Elite Insights, rather than claiming every mechanic event is a failure.

## Sources

- dps.report API: https://dps.report/api
- Elite Insights JSON model: https://github.com/baaron4/GW2-Elite-Insights-Parser

This is a fan-made project and is not affiliated with ArenaNet, NCSoft, dps.report, or Elite Insights.
