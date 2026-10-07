# Stage Manager Workspace v0.5.0

Offline-first PWA for stage management on an iPad/Chromebook. The app now supports multiple simultaneous productions in one local workspace.

## Main workflow

- **Tonight**: active production readiness, attendance summary, act preset progress, shared-asset warnings.
- **Presets**: one target-state checklist per act/section. Act II is the Act I -> Act II changeover target, Act III is the Act II -> Act III target, etc.
- **Run**: searchable prop/scenic movement track.
- **Check-in**: nightly cast and stage-crew attendance.
- **Shows**: switch between overlapping productions or create another production.
- **Manage**: production setup, people, locations, presets, run track, props, shared inventory, photos, import/export.

## Identity model

Every created record uses a permanent UUID. IDs are not regenerated when records are renamed, moved, exported, imported, or reassigned.

- A **production prop UUID** identifies that prop entry inside a production.
- A **shared asset UUID** identifies the actual reusable physical item across productions.
- Link a production prop to a shared asset only when it really is the same physical object.
- Bulk assets (for example 12 matching umbrellas) use one shared asset UUID plus a quantity.

Imports merge records by UUID, not by display name.

## Shared inventory and conflicts

1. Manage -> Inventory -> Add shared asset.
2. Choose **Unique physical item** or **Bulk / quantity pool**.
3. Manage -> Props -> edit a production prop and link it to the shared asset.
4. Set the reservation quantity/date range.
5. If two productions exceed availability during overlapping dates, the app flags the conflict on Tonight, Shows, Props and Inventory.

## Multiple productions

Shows -> + Production creates another show without removing the current one. Each production has its own acts, locations, people, presets, run track, photos, attendance, and production props. Shared people and shared inventory live at the workspace level.

## Local storage and transfer

The app stores workspace data in IndexedDB. Manage -> Backup supports:

- Export one production
- Export one production with locally replaced/uploaded photos
- Import/merge a production by UUID
- Export the entire workspace
- Merge or replace an entire workspace

Bundled preset photos stay in the app package; locally replaced or uploaded photos can be included in full backups.

## Upgrade from v0.4

v0.5 reads the existing v0.4 local production and migrates its records to permanent UUIDs. The bundled Peter and the Starcatcher records use deterministic UUIDs so the same starter records identify consistently across devices.

## Deployment

Upload the contents of this folder to the root of a GitHub Pages repository. `index.html` must be at the published root. The service worker cache name is versioned for v0.5.0 so the old v0.4 cache is replaced after the new service worker activates.
