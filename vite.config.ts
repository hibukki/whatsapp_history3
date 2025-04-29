import { defineConfig as defineViteConfig } from "vite";
import { defineConfig as defineVitestConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { mergeConfig } from "vite";

// Vite config
const viteConfig = defineViteConfig({
  plugins: [react()],
});

// Vitest config
const vitestConfig = defineVitestConfig({
  test: {
    globals: true, // Make expect, it, describe etc. available globally
    environment: "jsdom", // Or 'happy-dom' for faster tests if needed
  },
});

// https://vitejs.dev/config/
// Merge configs
export default mergeConfig(viteConfig, vitestConfig);
