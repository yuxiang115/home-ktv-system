import type { FastifyInstance } from "fastify";
import type { KtvIndexReadRepository } from "../modules/ktv-index/ktv-index-read-repository.js";

export interface AdminKtvIndexRouteDependencies {
  ktvIndex: KtvIndexReadRepository;
}

interface DiagnosticsQuery {
  q?: string;
  sampleSize?: string | number;
  sampleTimeoutMs?: string | number;
}

export async function registerAdminKtvIndexRoutes(
  server: FastifyInstance,
  dependencies: AdminKtvIndexRouteDependencies
): Promise<void> {
  server.get<{ Querystring: DiagnosticsQuery }>("/admin/ktv-index/diagnostics", async (request, reply) => {
    const previewQuery = String(request.query.q ?? "");
    const sampleSize = parseBoundedNumber(request.query.sampleSize, 12, 0, 50);
    const sampleTimeoutMs = parseBoundedNumber(request.query.sampleTimeoutMs, 250, 50, 1000);

    await reply.send(
      await dependencies.ktvIndex.getDiagnostics({
        previewQuery,
        previewLimit: 8,
        sampleSize,
        sampleTimeoutMs
      })
    );
  });

  server.get("/admin/ktv-index/dashboard", async (_request, reply) => {
    await reply.send(await dependencies.ktvIndex.getAdminDashboard());
  });
}

function parseBoundedNumber(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Math.min(max, Math.max(min, parsed || fallback));
}
