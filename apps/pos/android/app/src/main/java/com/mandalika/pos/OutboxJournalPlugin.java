package com.mandalika.pos;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A01b durable outbox journal: a tiny SQLite database with synchronous=FULL so a
 * committed sale survives a process kill or power loss (SharedPreferences cannot
 * promise that). Contract: packages/sync/src/journalPlugin.ts; reference
 * semantics: packages/sync/src/testFixtures/fakeJournal.ts.
 *
 * Thread model: ONE single-thread executor runs open/readAll/apply, so all
 * database work is serialized on one thread and one connection. The journal
 * mode is DELETE (rollback journal, no WAL), so the helper holds exactly one
 * connection and "PRAGMA synchronous=FULL" set in onConfigure applies to the
 * connection that runs apply; open() reports the value read back from it.
 *
 * Every call settles exactly once. apply() resolves only after
 * endTransaction() returned (the COMMIT happened) and rejects only when the
 * transaction rolled back (or the commit itself failed).
 *
 * Never log item_json or meta values: they can contain a transfer PIN.
 */
@CapacitorPlugin(name = "OutboxJournal")
public class OutboxJournalPlugin extends Plugin {
    private static final String TAG = "OutboxJournal";
    private static final String DB_NAME = "mandalika_journal.db";
    private static final int DB_VERSION = 1;
    // Values longer than this are read in chunks: a single row bigger than the
    // 2 MB CursorWindow would otherwise throw instead of being returned whole.
    private static final int INLINE_MAX = 200_000;
    private static final int CHUNK = 200_000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "OutboxJournal");
        t.setDaemon(true);
        return t;
    });
    // Touched only from the executor thread.
    private JournalHelper helper;
    private SQLiteDatabase db;

    private static final class JournalHelper extends SQLiteOpenHelper {
        JournalHelper(Context context) {
            super(context, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onConfigure(SQLiteDatabase d) {
            d.disableWriteAheadLogging();
            d.execSQL("PRAGMA synchronous=FULL");
        }

        @Override
        public void onCreate(SQLiteDatabase d) {
            d.execSQL("CREATE TABLE outbox (idempotency_key TEXT PRIMARY KEY, "
                    + "seq INTEGER NOT NULL UNIQUE, item_json TEXT NOT NULL)");
            d.execSQL("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase d, int oldVersion, int newVersion) {
            throw new IllegalStateException("unsupported journal schema version " + oldVersion);
        }
    }

    private interface Job {
        void run(PluginCall call) throws Exception;
    }

    /** Runs the job on the serialized executor; always settles the call. */
    private void submit(PluginCall call, Job job) {
        try {
            executor.execute(() -> {
                try {
                    job.run(call);
                } catch (Throwable e) {
                    Log.e(TAG, call.getMethodName() + " failed: " + e.getClass().getSimpleName());
                    call.reject(describe(e));
                }
            });
        } catch (Throwable e) {
            call.reject(describe(e));
        }
    }

    private static String describe(Throwable e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : ": " + m);
    }

    private SQLiteDatabase database() {
        if (db == null || !db.isOpen()) {
            if (helper == null) helper = new JournalHelper(getContext().getApplicationContext());
            db = helper.getWritableDatabase();
        }
        return db;
    }

    @PluginMethod
    public void open(PluginCall call) {
        submit(call, c -> {
            SQLiteDatabase d = database();
            StringBuilder quick = new StringBuilder();
            try (Cursor cur = d.rawQuery("PRAGMA quick_check", null)) {
                while (cur.moveToNext()) {
                    if (quick.length() > 0) quick.append('\n');
                    quick.append(cur.getString(0));
                }
            }
            String journalMode;
            try (Cursor cur = d.rawQuery("PRAGMA journal_mode", null)) {
                journalMode = cur.moveToFirst() ? cur.getString(0) : "unknown";
            }
            JSObject out = new JSObject();
            out.put("quickCheck", quick.toString());
            out.put("journalMode", journalMode);
            out.put("synchronous", DatabaseUtils.longForQuery(d, "PRAGMA synchronous", null));
            out.put("userVersion", DatabaseUtils.longForQuery(d, "PRAGMA user_version", null));
            c.resolve(out);
        });
    }

    @PluginMethod
    public void readAll(PluginCall call) {
        submit(call, c -> {
            SQLiteDatabase d = database();
            JSArray rows = new JSArray();
            List<Object[]> heads = new ArrayList<>();
            try (Cursor cur = d.rawQuery("SELECT idempotency_key, seq, "
                    + "CASE WHEN length(item_json) <= " + INLINE_MAX + " THEN item_json END, "
                    + "length(item_json) FROM outbox ORDER BY seq", null)) {
                while (cur.moveToNext()) {
                    heads.add(new Object[]{cur.getString(0), cur.getLong(1),
                            cur.isNull(2) ? null : cur.getString(2), cur.getLong(3)});
                }
            }
            for (Object[] h : heads) {
                String key = (String) h[0];
                String json = h[2] != null ? (String) h[2]
                        : readChunked(d, "outbox", "idempotency_key", "item_json", key, (Long) h[3]);
                JSObject row = new JSObject();
                row.put("key", key);
                row.put("seq", (Long) h[1]);
                row.put("json", json);
                rows.put(row);
            }
            JSObject meta = new JSObject();
            List<Object[]> metaHeads = new ArrayList<>();
            try (Cursor cur = d.rawQuery("SELECT k, "
                    + "CASE WHEN length(v) <= " + INLINE_MAX + " THEN v END, length(v) FROM meta", null)) {
                while (cur.moveToNext()) {
                    metaHeads.add(new Object[]{cur.getString(0),
                            cur.isNull(1) ? null : cur.getString(1), cur.getLong(2)});
                }
            }
            for (Object[] h : metaHeads) {
                String k = (String) h[0];
                meta.put(k, h[1] != null ? (String) h[1]
                        : readChunked(d, "meta", "k", "v", k, (Long) h[2]));
            }
            JSObject out = new JSObject();
            out.put("rows", rows);
            out.put("meta", meta);
            c.resolve(out);
        });
    }

    private static String readChunked(SQLiteDatabase d, String table, String keyCol, String valCol,
                                      String key, long length) {
        StringBuilder sb = new StringBuilder((int) Math.min(length, Integer.MAX_VALUE - 16));
        for (long off = 1; off <= length; off += CHUNK) {
            try (Cursor cur = d.rawQuery("SELECT substr(" + valCol + ", ?, ?) FROM " + table
                    + " WHERE " + keyCol + " = ?",
                    new String[]{String.valueOf(off), String.valueOf(CHUNK), key})) {
                if (!cur.moveToFirst()) throw new IllegalStateException("row vanished while reading");
                sb.append(cur.getString(0));
            }
        }
        return sb.toString();
    }

    private static final class Upsert {
        final String key;
        final long seq;
        final String json;

        Upsert(String key, long seq, String json) {
            this.key = key;
            this.seq = seq;
            this.json = json;
        }
    }

    @PluginMethod
    public void apply(PluginCall call) {
        submit(call, c -> {
            // Validate everything before touching the database: a malformed
            // request must reject with nothing written.
            List<Upsert> upserts = parseUpserts(c.getArray("upserts"));
            List<String> deletes = parseStrings(c.getArray("deletes"));
            JSObject metaIn = c.getObject("meta");
            Boolean replaceAllObj = c.getBoolean("replaceAll");
            boolean replaceAll = replaceAllObj != null && replaceAllObj;
            List<String[]> metaRows = new ArrayList<>();
            if (metaIn != null) {
                Iterator<String> it = metaIn.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = metaIn.opt(k);
                    if (!(v instanceof String)) throw new IllegalArgumentException("meta value must be a string");
                    metaRows.add(new String[]{k, (String) v});
                }
            }

            SQLiteDatabase d = database();
            boolean committed = false;
            d.beginTransaction();
            try {
                if (replaceAll) {
                    // Defence in depth: after takeover the journal is the system of record.
                    String migration = readMeta(d, "migration");
                    if ("verified".equals(migration) || "sealed".equals(migration)) {
                        throw new IllegalStateException("replaceAll refused: migration is " + migration);
                    }
                    d.delete("outbox", null, null); // outbox rows only, never meta
                }
                for (String key : deletes) {
                    d.delete("outbox", "idempotency_key = ?", new String[]{key});
                }
                for (Upsert u : upserts) {
                    ContentValues cv = new ContentValues();
                    cv.put("seq", u.seq);
                    cv.put("item_json", u.json);
                    // UPDATE then plain INSERT: a seq clash aborts the whole
                    // transaction instead of silently replacing another sale.
                    int n = d.update("outbox", cv, "idempotency_key = ?", new String[]{u.key});
                    if (n == 0) {
                        cv.put("idempotency_key", u.key);
                        d.insertOrThrow("outbox", null, cv);
                    }
                }
                for (String[] m : metaRows) {
                    ContentValues cv = new ContentValues();
                    cv.put("v", m[1]);
                    int n = d.update("meta", cv, "k = ?", new String[]{m[0]});
                    if (n == 0) {
                        cv.put("k", m[0]);
                        d.insertOrThrow("meta", null, cv);
                    }
                }
                d.setTransactionSuccessful();
                committed = true;
            } finally {
                // endTransaction performs the COMMIT (or the ROLLBACK when the
                // success flag was never set). If it throws, the commit failed
                // and the exception propagates to submit() -> reject.
                d.endTransaction();
            }
            if (committed) c.resolve();
        });
    }

    private static String readMeta(SQLiteDatabase d, String k) {
        try (Cursor cur = d.rawQuery("SELECT v FROM meta WHERE k = ?", new String[]{k})) {
            return cur.moveToFirst() ? cur.getString(0) : null;
        }
    }

    private static List<Upsert> parseUpserts(JSArray arr) throws JSONException {
        List<Upsert> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            Object key = o.opt("key");
            Object json = o.opt("json");
            Object seq = o.opt("seq");
            if (!(key instanceof String) || !(json instanceof String) || !(seq instanceof Number)) {
                throw new IllegalArgumentException("invalid upsert row");
            }
            double sd = ((Number) seq).doubleValue();
            if (sd != Math.rint(sd) || Math.abs(sd) > 9007199254740991d) {
                throw new IllegalArgumentException("seq must be an integer");
            }
            out.add(new Upsert((String) key, (long) sd, (String) json));
        }
        return out;
    }

    private static List<String> parseStrings(JSArray arr) throws JSONException {
        List<String> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            Object v = arr.get(i);
            if (!(v instanceof String)) throw new IllegalArgumentException("delete key must be a string");
            out.add((String) v);
        }
        return out;
    }

    @Override
    protected void handleOnDestroy() {
        try {
            executor.execute(() -> {
                try {
                    if (db != null) db.close();
                    if (helper != null) helper.close();
                } catch (Throwable e) {
                    Log.w(TAG, "close failed: " + e.getClass().getSimpleName());
                }
                db = null;
                helper = null;
            });
            executor.shutdown();
        } catch (Throwable ignored) {
            // already shut down
        }
        super.handleOnDestroy();
    }
}
