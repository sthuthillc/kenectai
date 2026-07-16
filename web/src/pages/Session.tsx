import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, isSignedIn, startSignIn, type SessionRecord, type SessionTask } from "../lib/api";

/**
 * Live session page — the agent's production run for one video, polled
 * every 2.5s while the session is active. Layout mirrors the studio
 * session surface: task board (left), preview/player (center), chat +
 * renders (right).
 */

const POLL_MS = 2500;

function StateDot({ state }: { state: SessionTask["state"] }) {
  const cls =
    state === "done"
      ? "bg-teal"
      : state === "running"
        ? "bg-sky animate-pulse"
        : state === "failed"
          ? "bg-magenta"
          : "bg-line";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />;
}

function TaskRow({ task }: { task: SessionTask }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span className="mt-1.5">
        <StateDot state={task.state} />
      </span>
      <div className="min-w-0">
        <p
          className={
            task.state === "done"
              ? "text-dim line-through"
              : task.state === "failed"
                ? "text-magenta"
                : task.state === "running"
                  ? "text-fg"
                  : "text-dim"
          }
        >
          {task.title}
        </p>
        <p className="text-xs text-dim/70">{task.id}</p>
        {task.note && task.state === "failed" && (
          <p className="mt-1 break-words text-xs text-magenta/80">{task.note}</p>
        )}
      </div>
    </li>
  );
}

export function Session() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "renders">("chat");
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const next = await api.getSession(id);
      setRecord(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    if (!isSignedIn()) {
      void startSignIn(`/sessions/${id ?? ""}`);
      return;
    }
    void refresh();
  }, [id, refresh]);

  useEffect(() => {
    if (!record || record.status === "completed" || record.status === "failed") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [record, refresh]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [record?.chat.length]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-16">
        <p className="text-magenta">Couldn’t load this session: {error}</p>
      </main>
    );
  }
  if (!record) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-16">
        <p className="text-dim">Loading session…</p>
      </main>
    );
  }

  const grouped = {
    running: record.tasks.filter((t) => t.state === "running" || t.state === "failed"),
    pending: record.tasks.filter((t) => t.state === "pending"),
    done: record.tasks.filter((t) => t.state === "done" || t.state === "skipped"),
  };

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            <span className="grad-text">{hostOf(record.url)}</span>
          </h1>
          <p className="text-sm text-dim">
            {record.status === "running" && "Composing…"}
            {record.status === "queued" && "Queued"}
            {record.status === "completed" && "Done"}
            {record.status === "failed" && "Failed"}
            {record.brief && ` · ${record.brief.length_s}s · ${record.brief.aspect}`}
          </p>
        </div>
        {record.video_url && (
          <a
            href={record.video_url}
            className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-ink hover:opacity-90"
            download
          >
            Download MP4
          </a>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr_320px]">
        {/* Tasks */}
        <section className="rounded-xl border border-line/60 bg-panel/40 p-4">
          <h2 className="mb-2 text-sm font-semibold text-dim">Tasks ({record.tasks.length})</h2>
          {grouped.running.length > 0 && (
            <>
              <p className="mt-3 text-xs uppercase tracking-wide text-sky">In progress</p>
              <ul>
                {grouped.running.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            </>
          )}
          {grouped.pending.length > 0 && (
            <>
              <p className="mt-3 text-xs uppercase tracking-wide text-dim">Not started</p>
              <ul>
                {grouped.pending.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            </>
          )}
          {grouped.done.length > 0 && (
            <>
              <p className="mt-3 text-xs uppercase tracking-wide text-teal">Completed</p>
              <ul>
                {grouped.done.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            </>
          )}
        </section>

        {/* Preview / player */}
        <section className="flex min-h-[360px] items-center justify-center rounded-xl border border-line/60 bg-panel/40 p-4">
          {record.video_url ? (
            <video
              src={record.video_url}
              controls
              className="max-h-[70vh] w-full rounded-lg"
              poster=""
            />
          ) : record.status === "failed" ? (
            <div className="max-w-md text-center">
              <p className="text-magenta">This run failed.</p>
              {record.error && <p className="mt-2 break-words text-sm text-dim">{record.error}</p>}
            </div>
          ) : (
            <div className="text-center">
              <div className="k-mark mx-auto mb-4 scale-150" aria-hidden>
                <div className="bar" />
                <div className="diamond" />
                <div className="play" />
                <div className="spark" />
              </div>
              <p className="text-dim">
                {record.brief ? `Crafting “${record.brief.message}”…` : "Crafting…"}
              </p>
            </div>
          )}
        </section>

        {/* Chat / renders */}
        <section className="flex max-h-[75vh] flex-col rounded-xl border border-line/60 bg-panel/40">
          <div className="flex border-b border-line/60 text-sm">
            <button
              className={`flex-1 px-4 py-3 ${tab === "chat" ? "border-b-2 border-teal text-fg" : "text-dim"}`}
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
            <button
              className={`flex-1 px-4 py-3 ${tab === "renders" ? "border-b-2 border-teal text-fg" : "text-dim"}`}
              onClick={() => setTab("renders")}
            >
              Renders
            </button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
            {tab === "chat" ? (
              <>
                {record.chat.map((m, i) => (
                  <div key={i} className="rounded-lg bg-ink/60 p-3">
                    <p className="text-fg/90">{m.text}</p>
                    <p className="mt-1 text-xs text-dim/60">
                      {new Date(m.ts * 1000).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </>
            ) : record.video_url ? (
              <a
                href={record.video_url}
                className="block rounded-lg bg-ink/60 p-3 text-teal hover:underline"
              >
                {record.render_id ?? "final render"} — download
              </a>
            ) : (
              <p className="text-dim">No renders yet — the final MP4 lands here.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
