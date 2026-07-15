import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { isSignedIn, signOut, startSignIn } from "../lib/api";

function Logo() {
  return (
    <a href="/" className="flex items-center gap-3">
      <div className="k-mark">
        <div className="bar" />
        <div className="diamond" />
        <div className="play" />
        <div className="spark" />
      </div>
      <span className="text-lg font-semibold tracking-wide">
        Kenect <span className="grad-text">AI</span>
      </span>
    </a>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const signedIn = isSignedIn();
  return (
    <div className="min-h-screen bg-ink text-fg flex flex-col">
      <header className="border-b border-line/60">
        <nav className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
          <Logo />
          <div className="flex items-center gap-6 text-sm text-dim">
            <Link to="/pricing" className="hover:text-fg transition-colors">
              Pricing
            </Link>
            <a href="https://docs.kenectai.com" className="hover:text-fg transition-colors">
              Docs
            </a>
            {signedIn ? (
              <>
                <Link to="/dashboard" className="hover:text-fg transition-colors">
                  Dashboard
                </Link>
                <button
                  onClick={() => {
                    signOut();
                    window.location.assign("/pricing");
                  }}
                  className="rounded-lg border border-line px-3 py-1.5 hover:border-dim hover:text-fg transition-colors"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => void startSignIn()}
                className="rounded-lg border border-line px-3 py-1.5 hover:border-dim hover:text-fg transition-colors"
              >
                Sign in
              </button>
            )}
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line/60">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-dim">
          <span>© {new Date().getFullYear()} KENECT AI · Sthuthi Technologies, LLC</span>
          <div className="flex gap-5">
            <a href="https://docs.kenectai.com" className="hover:text-fg transition-colors">
              Documentation
            </a>
            <a href="mailto:hello@kenectai.com" className="hover:text-fg transition-colors">
              hello@kenectai.com
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
