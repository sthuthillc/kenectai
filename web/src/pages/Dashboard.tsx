import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  type ApiKeySummary,
  type BillingStatus,
  isSignedIn,
  startSignIn,
} from "../lib/api";

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-teal/40 bg-teal/5 p-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-teal">{value}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-dim hover:text-fg"
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

function UsageMeter({ status }: { status: BillingStatus }) {
  const used = status.used_this_month ?? 0;
  const quota = status.quota ?? 0;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-dim">Renders this month</span>
        <span className="font-mono">
          {used}
          <span className="text-dim"> / {quota}</span>
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-panel2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet via-magenta to-teal transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Dashboard() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [billing, keyList] = await Promise.all([api.billingStatus(), api.listKeys()]);
      setStatus(billing);
      setKeys(keyList.keys);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await startSignIn("/dashboard");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn()) {
      void startSignIn("/dashboard");
      return;
    }
    void load();
  }, [load]);

  async function createKey() {
    setError(null);
    try {
      const created = await api.createKey(label.trim() || "default");
      setFreshKey(created.api_key);
      setLabel("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revoke(prefix: string) {
    setError(null);
    try {
      await api.revokeKey(prefix);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return <div className="py-32 text-center text-dim">Loading your dashboard…</div>;
  }

  const hasPlan = status?.plan === "premium" || status?.plan === "admin";

  return (
    <section className="mx-auto w-full max-w-5xl space-y-8 px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-dim">Your plan, usage, and API access.</p>
        </div>
        {!hasPlan && (
          <Link
            to="/pricing"
            className="rounded-xl bg-gradient-to-r from-violet via-magenta to-pink px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Upgrade to Premium
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-pink/40 bg-pink/5 p-3 text-sm text-pink">{error}</div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <div className="aura-border">
          <div className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Plan</h2>
              <span
                className={`rounded-full border px-3 py-0.5 text-xs ${
                  hasPlan
                    ? "border-teal/40 bg-teal/10 text-teal"
                    : "border-line bg-panel2 text-dim"
                }`}
              >
                {status?.plan === "admin" ? "Admin" : hasPlan ? "Premium — active" : "No plan"}
              </span>
            </div>
            {status?.plan === "premium" && status.current_period_end && (
              <p className="text-sm text-dim">
                Renews {new Date(status.current_period_end * 1000).toLocaleDateString()}
              </p>
            )}
            {status?.plan === "premium" && <UsageMeter status={status} />}
            {!hasPlan && (
              <p className="text-sm text-dim">
                Subscribe to unlock 300 renders/month, API keys, and MCP access.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-6">
          <h2 className="font-semibold">Connect an agent</h2>
          <p className="mt-1 text-xs text-dim">
            Point any MCP-capable agent at KENECT AI with your API key:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-ink p-3 font-mono text-[11px] leading-relaxed text-fg/80">
{`claude mcp add --transport http kenectai \\
  https://mcp.kenectai.com/mcp \\
  --header "X-Api-Key: kn_..."`}
          </pre>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-panel p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">API keys</h2>
          <div className="flex items-center gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Key label (e.g. ci)"
              className="rounded-lg border border-line bg-ink px-3 py-1.5 text-sm placeholder:text-dim/60 focus:border-dim focus:outline-none"
            />
            <button
              onClick={() => void createKey()}
              className="rounded-lg border border-teal/50 bg-teal/10 px-3 py-1.5 text-sm text-teal hover:bg-teal/20"
            >
              Create key
            </button>
          </div>
        </div>

        {freshKey && (
          <div className="mt-4 space-y-1.5">
            <p className="text-xs text-teal">
              Your new key — copy it now, it won't be shown again:
            </p>
            <CopyField value={freshKey} />
          </div>
        )}

        <div className="mt-5 divide-y divide-line/60 border-t border-line/60">
          {keys.length === 0 && (
            <p className="py-5 text-sm text-dim">No keys yet — create one to call the API.</p>
          )}
          {keys.map((key) => (
            <div key={key.prefix} className="flex items-center justify-between py-3 text-sm">
              <div className="flex items-center gap-4">
                <code className="font-mono text-fg/90">{key.prefix}…</code>
                <span className="text-dim">{key.label}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs text-dim">
                  {new Date(key.created_at * 1000).toLocaleDateString()}
                </span>
                <button
                  onClick={() => void revoke(key.prefix)}
                  className="text-xs text-pink/80 hover:text-pink"
                >
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
