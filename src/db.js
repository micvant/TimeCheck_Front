import Dexie from "dexie";

export const db = new Dexie("timecheck");

db.version(1).stores({
  tasks: "id, updated_at, deleted_at",
  time_entries: "id, task_id, updated_at, deleted_at, started_at",
  outbox: "id, table, record_id, client_updated_at",
  meta: "key",
});

export function nowIso() {
  return new Date().toISOString();
}

export function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
