import { useMemo, useState } from 'react';
import type { WalletEvalData } from '../types';

interface Props {
  data: WalletEvalData;
}

export function CopyTradeBacktest({ data }: Props) {
  const [latency, setLatency] = useState(3);
  const [slippage, setSlippage] = useState(5);
  const [gas, setGas] = useState(0.2);

  const result = useMemo(() => {
    const drift = latency * 1.8;
    const slipCost = slippage * 2;
    const gasDrag = gas * 4;
    const copierPct = data.walletPerTradePct - drift - slipCost - gasDrag * 0.1;
    const ratio = copierPct / data.walletPerTradePct;
    const copierUsd = data.wallet7dUsd * ratio;
    const trap = data.wallet7dUsd - copierUsd;
    return { copierPct, copierUsd, trap, ratio };
  }, [latency, slippage, gas, data]);

  return (
    <section className="panel backtest">
      <div className="panel-head">
        <h2>ILLUSTRATIVE COPY-TRADE CALCULATOR</h2>
      </div>
      <p className="formula">copy/trade = wallet% − latency drift − 2× slippage − gas</p>

      <div className="backtest-grid">
        <div>
          <div className="slider-block">
            <div className="lab">
              <span>Follow latency</span>
              <strong>{latency}s</strong>
            </div>
            <input
              type="range"
              min={0}
              max={30}
              step={0.5}
              value={latency}
              onChange={(e) => setLatency(Number(e.target.value))}
            />
          </div>
          <div className="slider-block">
            <div className="lab">
              <span>Slippage (1-side)</span>
              <strong>{slippage}%</strong>
            </div>
            <input
              type="range"
              min={0.1}
              max={20}
              step={0.1}
              value={slippage}
              onChange={(e) => setSlippage(Number(e.target.value))}
            />
          </div>
          <div className="slider-block">
            <div className="lab">
              <span>Gas/trade</span>
              <strong>{gas.toFixed(2)} $</strong>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={gas}
              onChange={(e) => setGas(Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <div className="compare">
            Per-trade net Wallet +{data.walletPerTradePct.toFixed(1)}% Copier {result.copierPct >= 0 ? '+' : ''}
            {result.copierPct.toFixed(1)}%
          </div>

          <div className="bt-bar-row">
            <div className="lab">
              <span>Wallet 7D</span>
              <strong>+${(data.wallet7dUsd / 1000).toFixed(1)}K</strong>
            </div>
            <div className="bt-bar">
              <span style={{ width: '100%' }} />
            </div>
          </div>

          <div className="bt-bar-row">
            <div className="lab">
              <span>Copier estimate · mock inputs</span>
              <strong>{result.copierUsd >= 0 ? '+' : '-'}${(Math.abs(result.copierUsd) / 1000).toFixed(1)}K</strong>
            </div>
            <div className="bt-bar">
              <span style={{ width: `${Math.max(0, result.ratio * 100)}%` }} />
            </div>
          </div>

          <div className="trap-box">
            <span className="lab">Copy-trap exposure</span>
            <span className="val">+${(result.trap / 1000).toFixed(1)}K</span>
          </div>
        </div>
      </div>
    </section>
  );
}
