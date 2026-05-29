import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

function previewAllowedHosts(envName: string): string[] {
  const value = process.env[envName]?.trim();
  if (!value) {
    return [];
  }

  try {
    return [new URL(value).hostname];
  } catch {
    const hostname = value.replace(/^https?:\/\//u, "").split("/")[0]?.split(":")[0]?.trim();
    return hostname ? [hostname] : [];
  }
}

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/test/**/*.test.{ts,tsx}"]
  },
  server: {
    host: "0.0.0.0",
    port: 5173
  },
  preview: {
    allowedHosts: previewAllowedHosts("TV_WEB_BASE_URL"),
    host: "0.0.0.0",
    port: 5173
  }
});
