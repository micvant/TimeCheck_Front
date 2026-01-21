const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

export function getToken() {
  return localStorage.getItem("timecheck_token");
}

export async function syncAll(db, userKey) {
  const lastSync =
    (await db.meta.get(`last_sync_at:${userKey}`))?.value ?? null;
  const outbox = (await db.outbox.toArray()).filter(
    (item) => item.user_id === userKey,
  );

  const changes = {
    tasks: outbox
      .filter((item) => item.table === "tasks")
      .map((item) => ({ op: item.op, data: item.payload })),
    time_entries: outbox
      .filter((item) => item.table === "time_entries")
      .map((item) => ({ op: item.op, data: item.payload })),
  };

  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/sync`, {
    method: "POST",
    headers,
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
        await db.tasks.put({ ...task, user_id: userKey });
      }
      for (const entry of data.time_entries) {
        await db.time_entries.put({ ...entry, user_id: userKey });
      }

      await db.outbox.where("user_id").equals(userKey).delete();
      await db.meta.put({
        key: `last_sync_at:${userKey}`,
        value: data.server_time,
      });
    },
  );

  return data.server_time;
}
