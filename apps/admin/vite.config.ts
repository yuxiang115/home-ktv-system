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
  server: {
    host: "0.0.0.0",
    port: 5174
  },
  preview: {
    allowedHosts: previewAllowedHosts("ADMIN_BASE_URL"),
    host: "0.0.0.0",
    port: 5174
  },
  test: {
    environment: "happy-dom",
    include: ["src/test/**/*.test.tsx"]
  }
});
