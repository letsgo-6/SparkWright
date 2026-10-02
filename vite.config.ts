// SPDX-License-Identifier: MPL-2.0
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  return {
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(env.WEB_PORT || 5310),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${Number(env.PORT || 5318)}` },
  },
  }
})
