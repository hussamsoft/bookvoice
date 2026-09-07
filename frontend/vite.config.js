import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` serves the UI on Vite's own port (default 5173, auto-bumps
    // when taken) and forwards /api to whichever 8000-8020 port the backend
    // actually picked — set BOOKVOICE_DEV_API when it isn't 8000.
    proxy: {
      '/api': {
        target: process.env.BOOKVOICE_DEV_API || 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
