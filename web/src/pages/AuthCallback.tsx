import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { completeSignIn } from "../lib/api";

export function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    // Auth codes are single-use — guard against React 18/19 double-invoke.
    if (ran.current) return;
    ran.current = true;
    completeSignIn(new URLSearchParams(window.location.search))
      .then((returnTo) => navigate(returnTo, { replace: true }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [navigate]);

  return (
    <section className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-32 text-center">
      {error ? (
        <div className="w-full rounded-2xl border border-pink/40 bg-pink/5 p-8">
          <h1 className="font-semibold text-pink">Sign-in failed</h1>
          <p className="mt-2 text-sm text-dim">{error}</p>
          <a href="/pricing" className="mt-4 inline-block text-sm text-teal hover:underline">
            Try again
          </a>
        </div>
      ) : (
        <p className="text-dim">Completing sign-in…</p>
      )}
    </section>
  );
}
