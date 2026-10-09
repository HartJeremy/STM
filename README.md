# Stage Manager Workspace v0.7.0

Multi-production stage-management PWA with Supabase relational sync and IndexedDB offline cache.

## v0.7 database migration

1. In Supabase -> SQL Editor, run `supabase-schema.sql` from this package. It is idempotent and adds the v0.7 `preset_checks` table/policies.
2. Deploy this package to GitHub Pages.
3. Open the app -> Manage -> Database.
4. Create a Supabase Auth account or sign in.
5. Click **Upload this workspace to Supabase** once. Existing production/entity UUIDs are preserved.
6. After migration, normal structured-data changes are saved locally first and synced to Supabase when online.

## Data synchronized in v0.7

- workspaces and productions
- people and production assignments
- acts and production locations
- shared inventory and reservations
- production props
- prop usage/movement records
- presets and nightly preset checks
- calls and attendance
- image metadata and preset photo assignments

Custom/replaced image BLOBs are still stored locally in IndexedDB in v0.7. Their metadata is synchronized, but cloud image-file storage is planned separately.

## Offline behavior

IndexedDB remains the immediate working copy. If the device is offline, edits remain local. When connectivity returns and the user is signed in with cloud sync enabled, the app schedules a Supabase sync.

## Security

The browser contains only the Supabase project URL and publishable key. Production data tables use Row Level Security and require an authenticated workspace member. Never place a Supabase secret/service-role key in this PWA.
