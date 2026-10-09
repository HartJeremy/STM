# Stage Manager Workspace v0.6.0

This build adds the Supabase project connection and the first relational database schema.

## Supabase setup

1. Open Supabase -> SQL Editor.
2. Run the entire `supabase-schema.sql` file once.
3. Deploy the PWA files to GitHub Pages.
4. Open Stage Manager -> Manage -> Database.
5. Click **Test connection**. It should report `Database connection successful`.

The browser build contains only the Supabase project URL and publishable key. Do not place a secret key, service_role key, database password, or JWT secret in this repository.

## Migration state

v0.6.0 intentionally keeps IndexedDB as the operational source of truth while the new relational schema is verified. It does not yet push/overwrite the Starcatcher workspace in Supabase. The next migration step is authenticated workspace sync and import of the current UUID-preserving Starcatcher data.

## Runtime files

The deployment no longer includes the original Starcatcher Word/Excel source documents. The built-in production seed is `data/seed-workspace.json`.
