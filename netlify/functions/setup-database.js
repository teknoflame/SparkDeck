// netlify/functions/setup-database.js
//
// Updates the database schema to match what SparkDeck needs.
// Adds missing columns to existing tables and creates new tables.
//
// Your actual schema uses INTEGER ids on folders/decks/cards and
// UUID ids on users. This script bridges the gap by adding the
// missing columns needed for multi-user support and future features.
//
// Safe to run multiple times.
//
// HOW TO USE:
//   1. Make sure DATABASE_URL is set in your .env.local
//   2. Run: npx netlify dev
//   3. Visit: http://localhost:8888/.netlify/functions/setup-database

const { query } = require("./utils/db");

// Each statement is run separately so one failure doesn't block others
const SCHEMA_STATEMENTS = [
    // --- Fix parent_folder_id on folders ---
    // It was added as UUID but folders.id is integer. Drop and re-add as integer.
    "ALTER TABLE folders DROP COLUMN IF EXISTS parent_folder_id",
    "ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_folder_id INTEGER",

    // --- Add user_id to folders (links folders to users) ---
    "ALTER TABLE folders ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id)",

    // --- Add user_id to decks (links decks to users) ---
    "ALTER TABLE decks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS idx_decks_user_id ON decks(user_id)",

    // --- Add visibility to decks (for future public/unlisted sharing) ---
    "ALTER TABLE decks ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'private'",

    // --- Add shuffle to decks (per-deck shuffle toggle, defaults to true) ---
    "ALTER TABLE decks ADD COLUMN IF NOT EXISTS shuffle BOOLEAN DEFAULT true",

    // --- Add media_url to cards (for YouTube embeds on card backs) ---
    "ALTER TABLE cards ADD COLUMN IF NOT EXISTS media_url TEXT",

    // --- Create user_settings table if not exists ---
    `CREATE TABLE IF NOT EXISTS user_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stats_enabled BOOLEAN DEFAULT true,
        dark_mode BOOLEAN DEFAULT false,
        font_size TEXT DEFAULT 'medium',
        high_contrast BOOLEAN DEFAULT false,
        reduced_motion BOOLEAN DEFAULT false,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,

    // --- Create study_sessions table if not exists ---
    `CREATE TABLE IF NOT EXISTS study_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deck_name TEXT NOT NULL,
        cards_studied INT DEFAULT 0,
        studied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,

    // --- Indexes ---
    "CREATE INDEX IF NOT EXISTS idx_study_sessions_user_id ON study_sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_study_sessions_date ON study_sessions(studied_at)",
    "CREATE INDEX IF NOT EXISTS idx_decks_visibility ON decks(visibility)",
];

exports.handler = async function (event) {
    // Gate behind admin secret — set ADMIN_SECRET in Netlify env vars to use
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!process.env.ADMIN_SECRET || token !== process.env.ADMIN_SECRET) {
        return {
            statusCode: 403,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Forbidden." }),
        };
    }

    const results = [];

    for (const sql of SCHEMA_STATEMENTS) {
        try {
            await query(sql);
            // Show first 60 chars of the SQL for context
            results.push("OK: " + sql.trim().substring(0, 60) + "...");
        } catch (error) {
            results.push("SKIP: " + error.message.substring(0, 80));
        }
    }

    // Show final schema
    try {
        const columnsResult = await query(
            `SELECT table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN ('users', 'folders', 'decks', 'cards', 'user_settings', 'study_sessions')
             ORDER BY table_name, ordinal_position`
        );

        const tables = {};
        for (const row of columnsResult.rows) {
            if (!tables[row.table_name]) tables[row.table_name] = [];
            tables[row.table_name].push(row.column_name + " (" + row.data_type + ")");
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                {
                    success: true,
                    message: "Schema update complete!",
                    results: results,
                    finalSchema: tables,
                },
                null,
                2
            ),
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ success: false, error: error.message, results }),
        };
    }
};
