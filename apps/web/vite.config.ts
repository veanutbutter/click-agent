import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const entry = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Relative URLs: the webview rewrites them, and the same build is previewable
  // straight from disk with no server.
  base: "./",
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Relative asset URLs so the in-editor webview can rewrite them onto
    // `webview.asWebviewUri`, and so the same build is previewable from disk.
    rollupOptions: {
      input: {
        index: entry("index.html"),
        agent: entry("agent.html"),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@click/bridge", "@click/contracts"],
  },
});
