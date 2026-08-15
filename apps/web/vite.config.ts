import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// M1 scaffold only: no Tailwind wiring, no path aliases, no dev-server
// proxy to apps/server yet. Those land with the frontend foundation
// (M6) per IMPLEMENTATION_PLAN.md §3. This file exists so apps/web is a
// real, runnable Vite + React + TS project today.
export default defineConfig({
  plugins: [react()],
});
