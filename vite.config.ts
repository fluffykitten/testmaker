import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('docx')) return 'vendor-docx';
            if (id.includes('xlsx')) return 'vendor-xlsx';
            if (id.includes('jszip')) return 'vendor-jszip';
            if (id.includes('pdfjs-dist') || id.includes('pdf-lib')) return 'vendor-pdf';
            if (id.includes('katex')) return 'vendor-katex';
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('react') || id.includes('react-dom')) return 'vendor-react';
          }
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
})
