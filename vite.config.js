import { defineConfig } from 'vite';

// base: './' — чтобы собранную статикку можно было открывать и раздавать
// из любой папки (в том числе с file:// на машинах без интернета).
export default defineConfig({
  base: './',
  server: {
    port: 5173,
  },
});
