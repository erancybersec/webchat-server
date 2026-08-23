import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { notificationsEnabled, registerServiceWorker, subscribePush } from './lib/notify';
import { applyTheme, initialTheme } from './lib/theme';
import './index.css';

// apply before the first paint so dark mode doesn't flash white
applyTheme(initialTheme());
// PWA install + notification delivery (Android requires SW notifications)
registerServiceWorker();
// Re-arm Web Push for anyone who already enabled notifications — covers a new
// device, a rotated subscription, or users from before push existed. Best
// effort; the in-page path still works without it.
if (notificationsEnabled()) void subscribePush().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
