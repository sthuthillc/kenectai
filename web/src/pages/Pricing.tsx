import { useState } from "react";
import { api, ApiError, isSignedIn, startSignIn } from "../lib/api";

const FEATURES = [
  "300 video renders per month",
  "Website-to-video: URL in, branded MP4 out",
  "Frame packs: brand tokens + showcase compositions",
  "Cloud rendering — no local Chrome or FFmpeg",
  "Per-user API keys for your agents and CI",
  "MCP server access (mcp.kenectai.com) for any AI agent",
  "OAuth sign-in shared with the CLI",
];

export function Pricing() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setError(null);
    if (!isSignedIn()) {
      await startSignIn("/pricing?resume=checkout");
      return;
    }
    setBusy(true);
    try {
      const { checkout_url } = await api.startCheckout();
      window.location.assign(checkout_url);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await startSignIn("/pricing?resume=checkout");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  // Returning from sign-in with ?resume=checkout → continue straight to Stripe.
  if (new URLSearchParams(window.location.search).get("resume") === "checkout" && isSignedIn() && !busy && !error) {
    window.history.replaceState(null, "", "/pricing");
    void subscribe();
  }

  return (
    <section className="relative overflow-hidden py-20">
      <div className="grid-mask pointer-events-none absolute inset-0" />
      <div className="relative mx-auto w-full max-w-3xl space-y-10 px-6">
        <div className="mx-auto max-w-xl space-y-4 text-center">
          <div className="flex justify-center">
            <span className="rounded-lg border border-line px-4 py-1 font-mono text-xs text-dim">
              Pricing
            </span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            One plan. <span className="grad-text">Every render.</span>
          </h1>
          <p className="text-sm text-dim md:text-base">
            Premium hosted video generation for agents and teams — websites, briefs, and
            compositions in, deterministic MP4s out.
          </p>
        </div>

        <div className="aura-border mx-auto max-w-lg">
          <div className="p-8">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">KENECT AI Premium</h2>
              <span className="rounded-full border border-teal/40 bg-teal/10 px-3 py-0.5 text-xs text-teal">
                300 renders/mo
              </span>
            </div>
            <div className="mt-6 flex items-end gap-1 text-dim">
              <span className="text-xl">$</span>
              <span className="-mb-1 text-5xl font-extrabold tracking-tight text-fg">499</span>
              <span>/month</span>
            </div>
            <ul className="mt-8 space-y-3 text-sm">
              {FEATURES.map((feature) => (
                <li key={feature} className="flex items-start gap-2.5">
                  <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-gradient-to-r from-violet to-magenta" />
                  <span className="text-fg/90">{feature}</span>
                </li>
              ))}
            </ul>
            <button
              onClick={() => void subscribe()}
              disabled={busy}
              className="mt-8 w-full rounded-xl bg-gradient-to-r from-violet via-magenta to-pink px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Opening secure checkout…" : isSignedIn() ? "Subscribe" : "Sign in & subscribe"}
            </button>
            {error && <p className="mt-3 text-sm text-pink">{error}</p>}
            <p className="mt-4 text-center text-xs text-dim">
              Secure checkout by Stripe · Cancel anytime
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
