import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  preview: { port: 4183, strictPort: true },
  build: { outDir: 'dist', assetsInlineLimit: 0, commonjsOptions:{include:[/node_modules/,/chat(?:Channels|Replies)\.cjs$/]} },
});
