# CarbonBit manual test checklist

Covers VS Code and live-provider integration that unit tests can't exercise. The deterministic pipeline
(adapters → usage → world → impact → storage → views → clear) is covered by `npm test`, including
[src/test/acceptance.test.ts](../src/test/acceptance.test.ts). Run before each release; note VS Code version and OS.

## Launch and layout

- [ ] `npm run compile` is clean and the Problems panel has no errors; **F5** starts the Extension Development Host without the "errors exist" prompt.
- [ ] CarbonBit icon appears in the Activity Bar; **CarbonBit: Open** reveals the sidebar.
- [ ] Sidebar renders and is readable in Dark, Light and High Contrast themes; resize narrow/wide without clipping.
- [ ] First run shows onboarding with detected tools and the "estimates, not measurements" disclaimer; dismissing it persists across reload.
- [ ] With no supported tool installed (or folders renamed), the empty state lists the four supported tools and the world still renders idle.

## Live providers (one request each, with the sidebar open)

- [ ] GitHub Copilot Chat: world goes Starting → Processing → Response → Idle; provider/model shown; today's totals update.
- [ ] Claude Code: same.
- [ ] GitHub Copilot CLI: same; input/cache totals appear after the CLI session exits (partial confidence before).
- [ ] Codex CLI: same.
- [ ] A failed/cancelled request shows the failure state, then returns to Idle.
- [ ] Installing a tool later is picked up within about 30 s (or right away by **CarbonBit: Refresh Usage**).
- [ ] During a Claude Code (or Copilot CLI) tool loop the world and live line stay "processing" between calls, and settle to Idle about 15 s after the last call.
- [ ] The live line shows the latest request's tokens; when idle it says how long ago it was (updates at least once a minute).
- [ ] "Last hour" bars grow with activity and the newest bar is highlighted; hovering a bar shows its time range and tokens.
- [ ] Copilot Chat in a *different* VS Code window (another folder) animates the world and updates totals.
- [ ] Close VS Code, use Claude Code or Codex CLI and Copilot Chat in another window, reopen: the output channel logs
      `imported N update(s) since the previous run`, today's totals include that usage, and the world stays Idle.
- [ ] The import does not freeze the editor (no "extension host unresponsive" entries attributed to CarbonBit).

## World and visuals

- [ ] Animation is smooth and capped by `carbonbit.animation.maxFps`; CPU stays low when idle (Task Manager / Process Explorer).
- [ ] Hiding the sidebar (switch view or collapse) pauses rendering; showing it resumes.
- [ ] `carbonbit.animation.enabled: false` and OS "reduce motion" show still frames.
- [ ] `carbonbit.visualMode`: `environmental`, `neutral` (no degradation) and `minimal` (no complex animation) apply without reload.
- [ ] The planet's day and night match the real time (your side is dark at night, with city lights), and the pin sits roughly at your timezone's longitude.
- [ ] Each state is recognisable at sidebar size: cyan arc (request), gold glow and vapour at the data center (processing), green return and ring (response), amber light (failure).
- [ ] Period tabs (Today, 30 days, Last month, Year) switch the footprint with mouse and arrow keys, and the choice survives hiding and showing the sidebar.
- [ ] Pixel icons and accents (amber for CO₂e, teal for water) read well in Dark, Light and High Contrast.

## Details, data and diagnostics

- [ ] **Show Details**: totals and provider shares match the sidebar; each model shows confidence and its reasons.
- [ ] **Show Details**: "Footprint over time" shows CO₂e and water for all four periods with the same comparisons as the sidebar; columns wrap on a narrow panel.
- [ ] **Show Methodology**: version, factors, assumptions, limitations and source links; the methodology document opens.
- [ ] Reload/restart VS Code: today's totals persist.
- [ ] `carbonbit.dataRetentionDays` change is accepted and logged in the **CarbonBit** output channel.
- [ ] **Clear Local Data**: cancel keeps data; confirm empties totals and providers; new activity is recorded afterwards.
- [ ] **Open Diagnostics**: versions, provider detection, last update and database health; no prompts, responses,
      file names, home folder, user name or workspace name. Output channel has no conversation content.

## Remote

- [ ] In a Remote (WSL/SSH/Dev Container) window, providers on the remote host are detected from that host only; local-only tools show as not detected (documented limitation).
