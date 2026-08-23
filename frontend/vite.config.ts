import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // '' prefix → also read the non-VITE_ dev knobs from .env.local / the shell.
  const env = loadEnv(mode, process.cwd(), '');
  // VITE_PROXY_TARGET lets QA point the dev UI at the sandbox backend (8090).
  const target = env.VITE_PROXY_TARGET ?? 'http://localhost:8080';
  // Local test rig: stand in for the Cloudflare Access identity header so the
  // dev UI acts as a signed-in agent (admin eran). Off unless the var is set —
  // production builds never set it, so this is dev-only and never bundled.
  const devAs = env.VITE_DEV_AS_EMAIL;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target,
          ...(devAs ? { headers: { 'cf-access-authenticated-user-email': devAs } } : {}),
        },
      },
    },
  };
});
