import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { AuthGate } from './components/AuthGate';
import { SolanaWalletProvider } from './solana/WalletProvider';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SolanaWalletProvider>
      <AuthGate>{(account) => <App account={account} />}</AuthGate>
    </SolanaWalletProvider>
  </StrictMode>,
);
