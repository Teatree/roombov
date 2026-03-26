import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'src/client',
  publicDir: '../../public',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@client': path.resolve(__dirname, 'src/client'),
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    open: true,
  },
});
