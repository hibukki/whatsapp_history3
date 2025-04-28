import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { InlineConfig } from "vitest";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true, // Make expect, it, describe etc. available globally
    environment: "jsdom", // Or 'happy-dom' for faster tests if needed
  } as InlineConfig, // Cast to Vitest config type
});
