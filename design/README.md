# Design ground truth — Claude Design canvas

`DroneMissions.dc.html` is the app's visual design, pulled from the Claude Design project
**DroneMissions Marketplace Prototype**
(https://claude.ai/design/p/bfa48adc-abf3-48a1-8976-6b1d2a992da8?file=DroneMissions.dc.html)
— the same canvas the original Angular frontend's CLAUDE.md names as its design source of truth.

Rules (carried over from the source project):
- **Design tokens, colors, spacing, and typography come from this canvas, not ad-hoc values.**
  Key tokens visible in the canvas: font `Space Grotesk` (+ `IBM Plex Mono` for mono), page bg
  gradient `#f2f5f9 → #e9edf2`, text `#1b2732`, link/primary `#2f6bff` (hover `#1e5ae6`),
  borders `#e5eaf0`, muted `#9aa8b6`, topbar 60px white with subtle shadow.
- When building or reviewing UI in `src/`, match the corresponding screen in this canvas;
  the ported Angular CSS is the implementation reference, the canvas is the design reference.
- Re-pull from the Claude Design project if the design evolves (DesignSync `get_file`).
