import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DialogProvider, TooltipLayer } from './components/Overlay';
import { ToastProvider } from './components/ui';
import './styles/base.css';
import './styles/components.css';
import './styles/controls.css';
import './styles/code.css';
import './styles/session.css';
import './styles/watch.css';
import './styles/views.css';
import './styles/themes.css';
import './styles/responsive.css';

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <DialogProvider>
            <App />
            <TooltipLayer />
          </DialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
