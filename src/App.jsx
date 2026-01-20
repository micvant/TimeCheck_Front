import { useEffect, useMemo, useState } from "react";
import { db, generateId, nowIso } from "./db.js";
import { getToken, syncAll } from "./sync.js";

const emptyForm = { title: "", description: "" };
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hrs = String(Math.floor(total / 3600)).padStart(2, "0");
  const mins = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [activeTaskId, setActiveTaskId] = useState("");
  const [comment, setComment] = useState("");
  const [tick, setTick] = useState(Date.now());
  const [syncStatus, setSyncStatus] = useState("idle");
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showTasks, setShowTasks] = useState(true);
  const [showHistory, setShowHistory] = useState(true);
  const [token, setToken] = useState(getToken());
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId),
    [tasks, activeTaskId],
  );

  const runningEntries = useMemo(
    () => entries.filter((entry) => !entry.stopped_at),
    [entries],
  );

  const runningEntry = useMemo(
    () => runningEntries.find((entry) => entry.task_id === activeTaskId) || null,
    [runningEntries, activeTaskId],
  );

  const storedTaskSeconds = useMemo(() => {
    if (!activeTaskId) {
      return 0;
    }
    return entries
      .filter((entry) => entry.task_id === activeTaskId)
      .reduce((sum, entry) => {
        if (!entry.started_at) {
          return sum;
        }
        const start = new Date(entry.started_at).getTime();
        if (!entry.stopped_at) {
          return sum;
        }
        const end = new Date(entry.stopped_at).getTime();
        const duration = Math.max(0, (end - start) / 1000);
        return sum + duration;
      }, 0);
  }, [entries, activeTaskId]);

  const getTaskSeconds = (taskId) => {
    const stored = entries
      .filter((entry) => entry.task_id === taskId && entry.stopped_at)
      .reduce((sum, entry) => {
        const start = new Date(entry.started_at).getTime();
        const end = new Date(entry.stopped_at).getTime();
        return sum + Math.max(0, (end - start) / 1000);
      }, 0);

    const running = entries
      .filter((entry) => entry.task_id === taskId && !entry.stopped_at)
      .reduce((sum, entry) => {
        const start = new Date(entry.started_at).getTime();
        return sum + Math.max(0, (tick - start) / 1000);
      }, 0);

    return stored + running;
  };

  const runningTaskSeconds = runningEntries
    .filter((entry) => entry.task_id === activeTaskId)
    .reduce((sum, entry) => {
      const start = new Date(entry.started_at).getTime();
      const duration = Math.max(0, (tick - start) / 1000);
      return sum + duration;
    }, 0);

  const activeTaskSeconds = storedTaskSeconds + runningTaskSeconds;

  const timerDisplaySeconds = activeTaskId ? activeTaskSeconds : 0;

  async function refreshData() {
    const [taskRows, entryRows, lastSyncRow] = await Promise.all([
      db.tasks.toArray(),
      db.time_entries.toArray(),
      db.meta.get("last_sync_at"),
    ]);

    const visibleTasks = taskRows.filter((task) => !task.deleted_at);
    const visibleEntries = entryRows.filter((entry) => !entry.deleted_at);

    setTasks(
      visibleTasks.sort((a, b) => a.created_at.localeCompare(b.created_at)),
    );
    setEntries(
      visibleEntries.sort((a, b) => b.started_at.localeCompare(a.started_at)),
    );

    setLastSyncAt(lastSyncRow?.value ?? null);
  }

  useEffect(() => {
    refreshData();
  }, []);

  useEffect(() => {
    const timerId = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (navigator.onLine) {
        handleSync();
      }
    }, 15000);

    const onOnline = () => handleSync();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  async function addOutbox(table, recordId, op, payload) {
    await db.outbox.put({
      id: generateId(),
      table,
      record_id: recordId,
      op,
      payload,
      client_updated_at: payload.client_updated_at,
    });
  }

  async function createTask() {
    if (!form.title.trim()) {
      return;
    }
    const now = nowIso();
    const task = {
      id: generateId(),
      title: form.title.trim(),
      description: form.description.trim() || null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      client_updated_at: now,
    };

    try {
      await db.tasks.put(task);
      await addOutbox("tasks", task.id, "upsert", task);
    } catch (error) {
      console.error(error);
      alert("Не удалось сохранить задачу локально.");
      return;
    }
    setForm(emptyForm);
    setActiveTaskId(task.id);
    await refreshData();
  }

  async function deleteTask(taskId) {
    const task = await db.tasks.get(taskId);
    if (!task) {
      return;
    }
    const now = nowIso();
    const updated = {
      ...task,
      deleted_at: now,
      updated_at: now,
      client_updated_at: now,
    };
    await db.tasks.put(updated);
    await addOutbox("tasks", taskId, "delete", updated);
    if (activeTaskId === taskId) {
      setActiveTaskId("");
    }
    await refreshData();
  }

  async function startTimer() {
    if (!activeTaskId) {
      alert("Выберите задачу перед стартом таймера.");
      return;
    }
    if (runningEntry) {
      return;
    }
    const now = nowIso();
    const entry = {
      id: generateId(),
      task_id: activeTaskId,
      started_at: now,
      stopped_at: null,
      comment: comment.trim() || null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      client_updated_at: now,
    };
    try {
      await db.time_entries.put(entry);
      await addOutbox("time_entries", entry.id, "upsert", entry);
    } catch (error) {
      console.error(error);
      alert("Не удалось сохранить запись таймера локально.");
      return;
    }
    setComment("");
    await refreshData();
  }

  async function stopTimer() {
    if (!runningEntry) {
      return;
    }
    const now = nowIso();
    const updated = {
      ...runningEntry,
      stopped_at: now,
      updated_at: now,
      client_updated_at: now,
    };
    await db.time_entries.put(updated);
    await addOutbox("time_entries", updated.id, "upsert", updated);
    await refreshData();
  }

  async function clearActiveTaskTime() {
    if (!activeTaskId) {
      return;
    }
    const now = nowIso();
    const taskEntries = await db.time_entries
      .where("task_id")
      .equals(activeTaskId)
      .toArray();
    if (taskEntries.length === 0) {
      return;
    }
    await db.transaction("rw", db.time_entries, db.outbox, async () => {
      for (const entry of taskEntries) {
        const updated = {
          ...entry,
          stopped_at: entry.stopped_at ?? now,
          deleted_at: now,
          updated_at: now,
          client_updated_at: now,
        };
        await db.time_entries.put(updated);
        await addOutbox("time_entries", updated.id, "delete", updated);
      }
    });
    await refreshData();
  }

  async function handleSync() {
    if (!getToken()) {
      setSyncStatus("error");
      setAuthError("Нужно войти, чтобы синхронизировать.");
      return;
    }
    try {
      setSyncStatus("syncing");
      const serverTime = await syncAll();
      setLastSyncAt(serverTime);
      setSyncStatus("ok");
    } catch (error) {
      console.error(error);
      setSyncStatus("error");
    }
  }

  async function registerUser() {
    setAuthError("");
    try {
      const response = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: authEmail.trim(),
          password: authPassword,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Register failed");
      }
      const data = await response.json();
      localStorage.setItem("timecheck_token", data.access_token);
      setToken(data.access_token);
      setAuthPassword("");
    } catch (error) {
      console.error(error);
      setAuthError("Не удалось зарегистрироваться.");
    }
  }

  async function loginUser() {
    setAuthError("");
    try {
      const body = new URLSearchParams();
      body.set("username", authEmail.trim());
      body.set("password", authPassword);

      const response = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Login failed");
      }
      const data = await response.json();
      localStorage.setItem("timecheck_token", data.access_token);
      setToken(data.access_token);
      setAuthPassword("");
    } catch (error) {
      console.error(error);
      setAuthError("Неверные данные для входа.");
    }
  }

  function logoutUser() {
    localStorage.removeItem("timecheck_token");
    setToken(null);
  }

  const statusLabel =
    syncStatus === "syncing"
      ? "Синхронизация..."
      : syncStatus === "ok"
        ? "Синхронизировано"
        : syncStatus === "error"
          ? "Ошибка синхронизации"
          : "Ожидание";

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>TimeCheck</h1>
          <p>Офлайн учет времени по задачам</p>
        </div>
        <div className="auth">
          {token ? (
            <div className="auth-logged">
              <div className="auth-status">Вход выполнен</div>
              <button onClick={logoutUser} type="button">
                Выйти
              </button>
            </div>
          ) : (
            <div className="auth-form">
              <input
                type="email"
                placeholder="Email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
              />
              <input
                type="password"
                placeholder="Пароль"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
              />
              <div className="auth-actions">
                <button onClick={loginUser} type="button">
                  Войти
                </button>
                <button onClick={registerUser} type="button">
                  Регистрация
                </button>
              </div>
              {authError && <div className="auth-error">{authError}</div>}
            </div>
          )}
        </div>
        <div className="sync">
          <button onClick={handleSync} type="button">
            Синхронизировать
          </button>
          <div className="sync-status">{statusLabel}</div>
          <div className="sync-meta">
            Последняя синхронизация: {lastSyncAt || "нет"}
          </div>
        </div>
      </header>

      <section className="panel">
        <h2>Новая задача</h2>
        <div className="form-row">
          <input
            type="text"
            placeholder="Название задачи"
            value={form.title}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, title: event.target.value }))
            }
          />
          <input
            type="text"
            placeholder="Описание"
            value={form.description}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, description: event.target.value }))
            }
          />
          <button onClick={createTask} type="button">
            Добавить
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Таймер</h2>
        <div className="timer">
          <div className="timer-info">
            <div className="timer-task">
              Активная задача:{" "}
              {activeTask ? activeTask.title : "не выбрана"}
            </div>
            <div className="timer-value">
              {formatDuration(timerDisplaySeconds)}
            </div>
          </div>
          <div className="timer-task-total">
            Суммарно по задаче: {formatDuration(activeTaskSeconds)}
          </div>
          <div className="timer-actions">
            <input
              type="text"
              placeholder="Комментарий для записи"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              disabled={!!runningEntry}
            />
            <button
              onClick={startTimer}
              type="button"
              disabled={!!runningEntry}
            >
              Старт
            </button>
            <button
              onClick={stopTimer}
              type="button"
              disabled={!runningEntry}
            >
              Стоп
            </button>
            <button
              onClick={clearActiveTaskTime}
              type="button"
              disabled={!activeTaskId}
            >
              Очистить время
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-header">
          <h2>Задачи</h2>
          <button
            type="button"
            className="toggle-button"
            onClick={() => setShowTasks((prev) => !prev)}
          >
            {showTasks ? "-" : "+"}
          </button>
        </div>
        {showTasks && (
          <div className="task-list">
            {tasks.length === 0 && (
              <div className="muted">Пока нет задач</div>
            )}
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`task-item ${
                  task.id === activeTaskId ? "active" : ""
                }`}
              >
                <div>
                  <div className="task-title">{task.title}</div>
                  {task.description && (
                    <div className="task-desc">{task.description}</div>
                  )}
                  <div className="task-time">
                    Время: {formatDuration(getTaskSeconds(task.id))}
                  </div>
                </div>
                <div className="task-actions">
                  <button
                    onClick={() => setActiveTaskId(task.id)}
                    type="button"
                  >
                    Выбрать
                  </button>
                  <button onClick={() => deleteTask(task.id)} type="button">
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-header">
          <h2>История</h2>
          <button
            type="button"
            className="toggle-button"
            onClick={() => setShowHistory((prev) => !prev)}
          >
            {showHistory ? "-" : "+"}
          </button>
        </div>
        {showHistory && (
          <div className="entries">
            {entries.length === 0 && (
              <div className="muted">Записей пока нет</div>
            )}
            {(() => {
              const uniqueEntries = [];
              const seen = new Set();
              for (const entry of entries) {
                if (seen.has(entry.task_id)) {
                  continue;
                }
                seen.add(entry.task_id);
                uniqueEntries.push(entry);
              }
              const visibleEntries = showAllHistory
                ? uniqueEntries
                : uniqueEntries.slice(0, 4);

              return (
                <>
                  {visibleEntries.map((entry) => {
                    const task = tasks.find(
                      (task) => task.id === entry.task_id,
                    );
                    const duration = entry.stopped_at
                      ? (new Date(entry.stopped_at).getTime() -
                          new Date(entry.started_at).getTime()) /
                        1000
                      : Math.max(
                          0,
                          (tick - new Date(entry.started_at).getTime()) / 1000,
                        );
                    return (
                      <div className="entry-item" key={entry.id}>
                        <div className="entry-main">
                          <div className="entry-task">
                            {task ? task.title : "Без задачи"}
                          </div>
                          <div className="entry-time">
                            {formatDuration(duration)}
                          </div>
                        </div>
                        <div className="entry-meta">
                          {entry.comment && <span>{entry.comment}</span>}
                          <span>{entry.started_at}</span>
                        </div>
                      </div>
                    );
                  })}
                  {!showAllHistory && uniqueEntries.length > 4 && (
                    <button
                      type="button"
                      onClick={() => setShowAllHistory(true)}
                    >
                      Показать еще
                    </button>
                  )}
                  {showAllHistory && uniqueEntries.length > 4 && (
                    <button
                      type="button"
                      onClick={() => setShowAllHistory(false)}
                    >
                      -
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </section>
    </div>
  );
}
