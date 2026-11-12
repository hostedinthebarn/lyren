// The credit line shown on every page (LYR-15, Counsel's draft E). It names no product, so it holds
// whatever the app ends up being called. /third-party-notices.txt is generated at build time
// (scripts/lib/third-party-notices.mjs) and served with the app.

export function CreditLine({ className }: { className?: string }) {
  return (
    <p className={className ?? 'px-4 py-3 text-center text-xs text-fg-subtle'}>
      Built on Lyren Plan by Darren Eberly, released under the{' '}
      <a className="underline hover:text-fg" href="/third-party-notices.txt" target="_blank" rel="noreferrer">
        MIT licence
      </a>
      .
    </p>
  );
}
