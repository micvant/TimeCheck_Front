import { db } from "./db.js";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export async function syncAll() {
  const lastSync = (await db.meta.get("last_sync_at"))?.value ?? null;
  const outbox = await db.outbox.toArray();

  const changes = {
    tasks: outbox
      .filter((item) => item.table === "tasks")
      .map((item) => ({ op: item.op, data: item.payload })),
    time_entries: outbox
      .filter((item) => item.table === "time_entries")
      .map((item) => ({ op: item.op, data: item.payload })),
  };

  const response = await fetch(`${API_BASE}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      last_sync_at: lastSync,
      changes,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Sync failed");
  }

  const data = await response.json();

  await db.transaction(
    "rw",
    db.tasks,
    db.time_entries,
    db.outbox,
    db.meta,
    async () => {
      for (const task of data.tasks) {
        await db.tasks.put(task);
      }
      for (const entry of data.time_entries) {
        await db.time_entries.put(entry);
      }

      await db.outbox.clear();
      await db.meta.put({ key: "last_sync_at", value: data.server_time });
    },
  );

  return data.server_time;
}
