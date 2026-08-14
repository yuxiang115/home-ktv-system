import { describe, expect, it } from "vitest";
import {
  InMemoryOnlineSupplementTaskRepository,
  summarizeSupplementTasks,
  type CreateSupplementTaskInput
} from "../modules/online-supplement/supplement-task-repository.js";

const BASE_TIME = new Date("2026-01-01T00:00:00Z");

function now(offsetMs = 0): Date {
  return new Date(BASE_TIME.getTime() + offsetMs);
}

function lease(offsetMs = 300_000): Date {
  return new Date(BASE_TIME.getTime() + offsetMs);
}

function createTaskInput(overrides: Partial<CreateSupplementTaskInput> = {}): CreateSupplementTaskInput {
  return {
    roomId: "living-room",
    provider: "youtube-yt-dlp",
    providerCandidateId: "vid-1",
    sourceUrl: "https://youtube.com/watch?v=vid-1",
    title: "Some Song (Official MV)",
    artistName: "Some Artist",
    durationMs: 240_000,
    providerPayload: {},
    workflowId: "youtube-enhanced",
    requestedBy: "phone-1",
    now: now(),
    ...overrides
  };
}

describe("InMemoryOnlineSupplementTaskRepository", () => {
  it("creates a task in discovered/download/pending", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const task = await repo.createTask(createTaskInput());
    expect(task.status).toBe("discovered");
    expect(task.stage).toBe("download");
    expect(task.stageStatus).toBe("pending");
    expect(task.workflowId).toBe("youtube-enhanced");
  });

  it("is idempotent for the same room/provider/candidate", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const first = await repo.createTask(createTaskInput());
    const second = await repo.createTask(createTaskInput());
    expect(second.id).toBe(first.id);
  });

  it("resurrects a failed task when the same candidate is requested again", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const created = await repo.createTask(createTaskInput());
    await repo.markFailed({
      taskId: created.id,
      failureStage: "download",
      reason: "boom",
      now: now(1_000)
    });

    const resurrected = await repo.createTask(
      createTaskInput({ title: "Some Song (Remastered)", now: now(2_000) })
    );

    expect(resurrected.id).toBe(created.id);
    expect(resurrected.status).toBe("discovered");
    expect(resurrected.stage).toBe("download");
    expect(resurrected.stageStatus).toBe("pending");
    expect(resurrected.stageProgressPercent).toBe(0);
    expect(resurrected.failureReason).toBeNull();
    expect(resurrected.title).toBe("Some Song (Remastered)");

    // 复活后 worker 能重新认领
    const claimed = await repo.claimForStage({
      stage: "download",
      workerId: "w1",
      leaseUntil: lease(),
      now: now(3_000)
    });
    expect(claimed?.id).toBe(created.id);
  });

  it("claims a pending task and flips it to running, then refuses to re-claim", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    await repo.createTask(createTaskInput());

    const claimed = await repo.claimForStage({
      stage: "download",
      workerId: "w1",
      leaseUntil: lease(),
      now: now(5_000)
    });
    expect(claimed?.stageStatus).toBe("running");
    expect(claimed?.status).toBe("processing");
    expect(claimed?.workerId).toBe("w1");

    const again = await repo.claimForStage({
      stage: "download",
      workerId: "w2",
      leaseUntil: lease(),
      now: now(6_000)
    });
    expect(again).toBeNull();
  });

  it("claims a batch only for tasks at that stage", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();

    const empty = await repo.claimBatchForStage({
      stage: "rename",
      workerId: "w1",
      leaseUntil: lease(),
      now: now(),
      batchSize: 2
    });
    expect(empty).toHaveLength(0);

    const t1 = await repo.createTask(createTaskInput({ providerCandidateId: "v1" }));
    const t2 = await repo.createTask(createTaskInput({ providerCandidateId: "v2" }));
    for (const created of [t1, t2]) {
      const claimed = await repo.claimForStage({
        stage: "download",
        workerId: "w1",
        leaseUntil: lease(),
        now: now()
      });
      expect(claimed?.id).toBe(created.id);
      await repo.completeStage({
        taskId: created.id,
        nextStage: "rename",
        now: now()
      });
    }

    const batch = await repo.claimBatchForStage({
      stage: "rename",
      workerId: "w1",
      leaseUntil: lease(),
      now: now(),
      batchSize: 2
    });
    expect(batch).toHaveLength(2);
    expect(batch.every((task) => task.stageStatus === "running")).toBe(true);
  });

  it("advances a task through stages preserving artifacts, then marks ready", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const created = await repo.createTask(createTaskInput());
    const claimed = await repo.claimForStage({
      stage: "download",
      workerId: "w1",
      leaseUntil: lease(),
      now: now()
    });
    expect(claimed?.id).toBe(created.id);

    await repo.completeStage({
      taskId: created.id,
      nextStage: "rename",
      llmRenamedTitle: "SomeArtist-SomeSong-国语-流行",
      now: now(10_000)
    });

    const afterRename = await repo.findById(created.id);
    expect(afterRename?.stage).toBe("rename");
    expect(afterRename?.stageStatus).toBe("pending");
    expect(afterRename?.llmRenamedTitle).toBe("SomeArtist-SomeSong-国语-流行");

    await repo.markReady({
      taskId: created.id,
      readySongId: "song-1",
      finalFilePath: "/mnt/nas/KTV歌曲/_online/x.mkv",
      lyricFile: "/mnt/nas/KTV歌曲/_online/x.lrc",
      now: now(60_000)
    });
    const ready = await repo.findById(created.id);
    expect(ready?.status).toBe("ready");
    expect(ready?.stageStatus).toBe("done");
    expect(ready?.readySongId).toBe("song-1");
    expect(ready?.workerId).toBeNull();
  });

  it("marks a task failed with the failing stage and clears the lease", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const task = await repo.createTask(createTaskInput());
    await repo.markFailed({
      taskId: task.id,
      failureStage: "download",
      reason: "network timeout",
      now: now(30_000)
    });
    const failed = await repo.findById(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.failureStage).toBe("download");
    expect(failed?.failureReason).toBe("network timeout");
    expect(failed?.workerId).toBeNull();
  });

  it("reclaims stale leases back to pending", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const task = await repo.createTask(createTaskInput());
    await repo.claimForStage({
      stage: "download",
      workerId: "w1",
      leaseUntil: now(10_000),
      now: now(5_000)
    });

    const reclaimed = await repo.reclaimStaleLeases(now(20_000));
    expect(reclaimed).toBe(1);

    const after = await repo.findById(task.id);
    expect(after?.stageStatus).toBe("pending");
    expect(after?.workerId).toBeNull();

    const reclaimedAgain = await repo.reclaimStaleLeases(now(21_000));
    expect(reclaimedAgain).toBe(0);
  });

  it("renews an active lease", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const task = await repo.createTask(createTaskInput());
    await repo.claimForStage({
      stage: "download",
      workerId: "w1",
      leaseUntil: now(10_000),
      now: now()
    });

    await repo.renewLease({
      taskId: task.id,
      workerId: "w1",
      leaseUntil: now(500_000),
      now: now(5_000)
    });

    const reclaimed = await repo.reclaimStaleLeases(now(20_000));
    expect(reclaimed).toBe(0);
  });

  it("lists recent tasks as summaries, preferring the renamed title", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    const task = await repo.createTask(createTaskInput());

    const summaries = await repo.listRecentByRoom("living-room", 10);
    expect(summaries).toHaveLength(1);
    const first = summaries[0];
    expect(first?.title).toBe("Some Song (Official MV)");
    expect(first?.taskId).toBe(task.id);

    await repo.completeStage({
      taskId: task.id,
      nextStage: "rename",
      llmRenamedTitle: "Artist-Song-国语-流行",
      now: now()
    });

    const afterRename = await repo.listRecentByRoom("living-room", 10);
    expect(afterRename[0]?.title).toBe("Artist-Song-国语-流行");
  });
});

describe("summarizeSupplementTasks", () => {
  it("counts by status plus total", async () => {
    const repo = new InMemoryOnlineSupplementTaskRepository();
    await repo.createTask(createTaskInput({ providerCandidateId: "v1" }));
    await repo.createTask(createTaskInput({ providerCandidateId: "v2" }));
    const t3 = await repo.createTask(createTaskInput({ providerCandidateId: "v3" }));
    await repo.markReady({
      taskId: t3.id,
      readySongId: "s1",
      finalFilePath: "x.mkv",
      lyricFile: null,
      now: now()
    });

    const summaries = await repo.listRecentByRoom("living-room", 10);
    const summary = summarizeSupplementTasks(summaries);
    expect(summary.counts.total).toBe(3);
    expect(summary.counts.discovered).toBe(2);
    expect(summary.counts.ready).toBe(1);
  });
});
