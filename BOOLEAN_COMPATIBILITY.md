# PostgreSQL boolean compatibility

The original SQLite application represented boolean flags as `0`/`1`. Supabase/PostgreSQL may represent the same fields as `BOOLEAN` (`true`/`false`).

The backend database adapter now translates the legacy flag comparisons and parameter values at query time. **Do not change the Supabase column types manually.** Existing boolean columns can remain boolean, and newly-created columns from `src/db/schema.sql` can remain compatible with the application.

In particular, queries such as `WHERE is_active = 1` are sent to PostgreSQL as `WHERE is_active = TRUE`.
