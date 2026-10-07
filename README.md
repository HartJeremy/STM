# Stage Manager Quick List PWA

Version 0.4.0

## Purpose
Offline-first iPad stage-management tool. Peter and the Starcatcher remains the bundled starter production, but the app can now be reused for other productions.

## Core workflow
- **Tonight**: company check-in plus readiness for every act/section.
- **Presets**: each act has a target preset. Act 1 is the preshow preset; Act 2 and later are the required setup/changeover state before that act. This replaces the old hard-coded Intermission page.
- **Run**: searchable prop/scenic movement track.
- **Check-in**: nightly actor and stage-crew attendance.
- **Manage**: production, acts, locations, presets, people, movements, props, photos, and backups.

## New in v0.4
- Added **Manage > Locations**. Locations can be added, renamed, reordered, and deleted when unused. Renaming cascades to preset records and photo assignments.
- Preset editing now selects from managed locations rather than requiring free-text location entry.
- Added **Manage > Production** with editable production details and arbitrary acts/sections.
- Acts can be added, renamed, reordered, or removed. One-act, two-act, and multi-act shows are supported.
- Removed the special Intermission model. Every act after the first uses its preset as the changeover/setup checklist from the previous act.
- Added **Start new production**. A full backup of the current production downloads first, then a clean production workspace is created.
- Data/full-backup filenames use the current production name.
- Import supports both v0.4 generic backups and earlier Starcatcher v0.3 backups.
- App updates no longer merge Starcatcher seed data into a different locally-created production.

## Peter and the Starcatcher source hierarchy
1. `PETER & THE STARCATCHER PRESETS.docx` — authoritative preset/changeover state.
2. `PETER & THE STARCATCHER PROPS.docx` — authoritative backstage prop inventory.
3. `STARCATCHER PROPS(2).xlsx` — movement/responsibility track.
4. Supplied photos — visual verification and editable reference images.

## Install on iPad
Publish this folder to an HTTPS static host such as GitHub Pages. Open it once in Safari and choose Share > Add to Home Screen. The service worker caches the application and bundled Starcatcher reference images for offline use.

## Using another production
Go to **Manage > Production > Start new production**. The current production downloads as a full backup first. Add the show's acts/sections, locations, people, props, presets, run movements, and reference photos.

## Sharing without a server
- **Export data**: editable production data only.
- **Export full backup**: production data, nightly checks, and locally uploaded/replaced photos.
- **Import + merge**: for updates to the same production.
- **Import + replace**: to restore/switch to another production.
