import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { SOLANA_RPC, USING_RPC_PROXY } from './constants';
import { getLocalToken } from '../localToken';

import '@solana/wallet-adapter-react-ui/styles.css';

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const endpoint = SOLANA_RPC;
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider
      endpoint={endpoint}
      config={{
        commitment: 'confirmed',
        fetch: (input, init) => {
          const token = getLocalToken();
          if (!USING_RPC_PROXY || !token) return fetch(input, init);
          const headers = new Headers(init?.headers);
          headers.set('X-GMGN-Token', token);
          return fetch(input, { ...init, headers });
        },
      }}
    >
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
