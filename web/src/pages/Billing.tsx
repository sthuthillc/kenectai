import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type BillingStatus, isSignedIn } from "../lib/api";

/** Post-checkout landing: poll until the Stripe webhook flips the plan on. */
export function BillingSuccess() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (!isSignedIn()) return;
    if (status?.plan === "premium" || attempts >= 15) return;
    const timer = setTimeout(() => {
      api
        .billingStatus()
        .then(setStatus)
        .catch(() => {})
        .finally(() => setAttempts((n) => n + 1));
    }, attempts === 0 ? 0 : 2000);
    return () => clearTimeout(timer);
  }, [attempts, status]);

  const active = status?.plan === "premium";

  return (
    <section className="mx-auto flex w-full max-w-lg flex-col items-center px-6 py-24 text-center">
      <div className="aura-border w-full">
        <div className="space-y-4 p-10">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-teal/40 bg-teal/10 text-2xl">
            {active ? "✓" : "⏳"}
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {active ? (
              <>
                Welcome to <span className="grad-text">Premium</span>
              </>
            ) : (
              "Payment received"
            )}
          </h1>
          <p className="text-sm text-dim">
            {active
              ? "Your subscription is active. 300 renders/month are ready to burn."
              : attempts >= 15
                ? "Your payment went through — activation is taking a little longer than usual. Refresh in a minute, or contact hello@kenectai.com."
                : "Activating your plan… this usually takes a few seconds."}
          </p>
          <div className="pt-2">
            <Link
              to="/dashboard"
              className="inline-block rounded-xl bg-gradient-to-r from-violet via-magenta to-pink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              Go to your dashboard
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function BillingCancelled() {
  return (
    <section className="mx-auto flex w-full max-w-lg flex-col items-center px-6 py-24 text-center">
      <div className="w-full rounded-2xl border border-line bg-panel p-10">
        <h1 className="text-2xl font-bold tracking-tight">Checkout cancelled</h1>
        <p className="mt-3 text-sm text-dim">
          No charge was made. Your plan is unchanged — come back whenever you're ready.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            to="/pricing"
            className="rounded-xl bg-gradient-to-r from-violet via-magenta to-pink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Back to pricing
          </Link>
          <a
            href="mailto:hello@kenectai.com"
            className="rounded-xl border border-line px-5 py-2.5 text-sm text-dim hover:text-fg"
          >
            Talk to us
          </a>
        </div>
      </div>
    </section>
  );
}
