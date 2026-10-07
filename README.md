# Starcatcher Stage Manager PWA

Version 0.3.0

## Purpose
Offline-first iPad stage-management tool for Peter and the Starcatcher. It combines the written preset/backstage-prop documents, the prop movement spreadsheet, visual preset references, and a nightly company check-in.

## What changed in v0.3
- Rebuilt mobile/iPad navigation around Tonight, Presets, Run, Check-in, and Manage.
- Fixed Run Track search so typing filters existing rows without rebuilding the input; the keyboard/focus stays open.
- Added nightly cast + stage-crew check-in with Waiting, Here, Late, Missing, Excused, and Not called states.
- Added editable People roster. Cast is seeded from the production cast list; Stage Manager is seeded under crew and additional crew can be added.
- Added Image Library management. Any preset area can use any Act I/Act II library photo.
- Bundled photos can be replaced locally without republishing the app; uploaded photos can be added to the library.
- Added data-only export and a Full Backup export that includes locally uploaded/replaced images.
- Preset checks are now nightly, so a new calendar date starts with a clean checklist.

## Source hierarchy
1. `PETER & THE STARCATCHER PRESETS.docx` — authoritative Act I / Act II preset and intermission setup.
2. `PETER & THE STARCATCHER PROPS.docx` — authoritative backstage SR/SL prop inventory and quantities.
3. `STARCATCHER PROPS(2).xlsx` — prop movement / responsibility run track.
4. Supplied Act I / Act II photos — visual verification that can be reassigned or replaced in the app.

## Install on iPad
Publish this folder to an HTTPS static host such as GitHub Pages. Open it once in Safari, then Share > Add to Home Screen. After the first complete load, the app works offline.

## Sharing without a server
- **Export data**: small JSON file for show-data changes when bundled photos are unchanged.
- **Export full backup**: includes show data, nightly checks, and any locally uploaded/replaced photos. Use this when another device needs the same custom images.
- Import using **Merge** for normal collaboration or **Replace** when the incoming file should become the master copy.
