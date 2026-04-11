import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { monadTestnet } from './chain';

const projectId = process.env.NEXT_PUBLIC_PROJECT_ID || 'demo';

export const config = getDefaultConfig({
  appName: 'Mako Markets',
  projectId,
  chains: [monadTestnet],
  ssr: true,
});
