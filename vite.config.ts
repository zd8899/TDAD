import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  
  // Entry point for the webview
  root: 'src/presentation/webview',
  
  build: {
    // Output to the media directory (where VS Code expects webview files)
    outDir: '../../../media',
    emptyOutDir: false, // Preserve existing files (GIFs, images, etc.)
    
    // Generate a single JS file for easier VS Code webview loading
    rollupOptions: {
      input: resolve(__dirname, 'src/presentation/webview/index.html'),
      output: {
        entryFileNames: 'canvas-react.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    },
    
    // Keep readable for debugging in development
    minify: process.env.NODE_ENV === 'production',
    
    // Target web environment (VS Code webview)
    target: 'es2020',
    
    // Source maps for debugging
    sourcemap: true
  },
  
  // Development server configuration (for local testing)
  server: {
    port: 5173,
    open: false // Don't auto-open browser
  },
  
  // Resolve configuration
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@webview': resolve(__dirname, 'src/presentation/webview')
    }
  },
  
  // CSS configuration
  css: {
    devSourcemap: true
  },
  
  // Define global constants
  define: {
    // VS Code webview environment
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  }
});
