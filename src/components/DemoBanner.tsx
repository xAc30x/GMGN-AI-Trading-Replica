export function DemoBanner() {
  return (
    <div className="demo-banner">
      <span aria-hidden>⚠</span>
      <span>
        Unaffiliated UI replica · SHADOW = mock only · PAPER = quote/rug/simulate (no send) · LIVE =
        wallet-signed SOL via Jupiter — not official GMGN, not investment advice.
      </span>
      <a
        href="https://gmgnai.github.io/skillmarket-demos/aitrader/"
        target="_blank"
        rel="noreferrer"
      >
        View reference ↗
      </a>
    </div>
  );
}
