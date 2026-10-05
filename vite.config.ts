// SPDX-License-Identifier: MPL-2.0
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { mkdirSync, copyFileSync } from 'node:fs'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const community = mode === 'community'
  return {
  plugins: [react(), ...(community ? [{name:'community-static-brand',closeBundle(){mkdirSync('dist-community/brand',{recursive:true});copyFileSync('public/brand/spark-logo.png','dist-community/brand/spark-logo.png')}}] : [])],
  define: { 'import.meta.env.VITE_COMMUNITY_EDITION': JSON.stringify(community ? 'true' : 'false') },
  publicDir: community ? false : 'public',
  build: community ? { outDir:'dist-community',rollupOptions:{input:path.resolve('community.html')} } : {},
  server: {
    host: '127.0.0.1',
    port: Number(env.WEB_PORT || 5310),
    strictPort: true,
    proxy: { '/api': { target:`http://127.0.0.1:${Number(env.PORT || 5318)}`,ws:true } },
  },
  }
})
