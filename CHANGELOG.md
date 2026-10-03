# Change Log

All notable changes to the "vscode-carbonbit" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased] - 0.0.1

First MVP (PRD v0.1).

- Redesigned sidebar: the pixel world and a live status strip share one frame, followed by a "Last hour" activity chart (two-minute bars), session counters, the footprint with period tabs (Today, 30 days, Last month, Year) and a stacked bar of tools.
- Everyday comparisons: every CO₂e and water figure shows what it is about the same as (km driving, by train or flying; kettle boils, phone charges, LED hours; mugs of tea, shower minutes, washing machine loads, baths, dishwasher cycles, days of drinking water), with pixel icons. Factors and sources are in methodology `carbonbit-impact` 1.1.0.
- Details panel: a "Footprint over time" grid with CO₂e and water for today, the last 30 days, the previous month and a projected year.
- Rebuilt pixel world ("Two Rooms, One Wire", see `docs/WORLD_ART.md`): the developer's room and the data hall joined by one wire. The sky follows the local time of day, and every state stays distinct with reduced motion.
- Live line shows the latest request's tokens and how long ago it finished. Claude Code and Copilot CLI agent loops (calls logged only once they finish) now keep the world and the live line in "processing" instead of flickering back to idle.
- More reliable live tracking: tools installed after start are detected automatically (every 30 s), a briefly unreadable log folder no longer replays history as live activity, unfinished Claude Code calls no longer stay "processing" for minutes, and Codex sessions whose file times lag are imported on start.

- Activity Bar sidebar with a reactive 16-bit pixel world (idle, request starting, light/medium/heavy processing, response, failure); FPS cap, reduced motion, hidden-view pause; `environmental`, `neutral` and `minimal` visual modes.
- Local usage tracking for GitHub Copilot Chat, Claude Code, GitHub Copilot CLI and Codex CLI from their session logs; providers fail independently.
- Copilot Chat usage is tracked across all workspaces of the running VS Code, not only the current window.
- On start, usage logged since the previous run is imported in the background into history, without animating the world. The first time (and once on existing installs), the import reaches back as far as the tools' logs go, within `carbonbit.dataRetentionDays` and at most a year. Large logs are read in slices to keep the editor responsive.
- Periods with no recorded history (for example the month before your tools' logs begin) say "no data" instead of showing zeros; partly covered periods say from which day data starts.
- Storing requests is about 18 times faster (SQLite `synchronous = NORMAL` with WAL), so large imports no longer hold up the extension host.
- Energy, CO₂e and water estimates with High/Medium/Low confidence and reasons; versioned methodology (`carbonbit-impact` 1.1.0, see `docs/METHODOLOGY.md`).
- Live status, today's totals and provider shares; Details and Methodology panel.
- Local SQLite history (`node:sqlite`) with `carbonbit.dataRetentionDays`, corruption recovery and **Clear Local Data**.
- Commands: Open, Refresh Usage, Show Details, Show Methodology, Clear Local Data, Open Diagnostics (redacted report).
- No telemetry, no network access; prompts, responses, code and file names are never stored or sent.