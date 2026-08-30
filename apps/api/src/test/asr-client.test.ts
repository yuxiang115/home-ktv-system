import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transcribeAudio } from "../modules/online-supplement/asr-client.js";

// Qwen3-ASR(OpenAI whisper 风格)客户端契约:POST {base}/v1/audio/transcriptions,
// multipart file+model(+prompt),响应 {text, segments?}(秒)。
describe("asr-client transcribeAudio", () => {
  it("posts multipart file/model/prompt and normalizes the response", async () => {
    const audioPath = await createFakeAudio();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return Response.json({
        text: "演員",
        segments: [
          { start: 1.5, end: 3, text: "演員" },
          { start: "bad", end: 4, text: "非法段被丢弃" }
        ]
      });
    }) as typeof fetch;

    const result = await transcribeAudio({
      baseUrl: "http://mac-asr.local:8000/",
      model: "mlx-community/Qwen3-ASR-1.7B-4bit",
      filePath: audioPath,
      prompt: "这是薛之謙演唱的歌曲《演員》，请转写歌词文本",
      fetchImpl
    });

    expect(result.text).toBe("演員");
    expect(result.segments).toEqual([{ start: 1.5, end: 3, text: "演員" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://mac-asr.local:8000/v1/audio/transcriptions");
    expect(requests[0]?.init.method).toBe("POST");
    const body = requests[0]?.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("model")).toBe("mlx-community/Qwen3-ASR-1.7B-4bit");
    expect(body.get("prompt")).toBe("这是薛之謙演唱的歌曲《演員》，请转写歌词文本");
    const file = body.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("audio.m4a");
  });

  it("returns empty segments when the service omits them", async () => {
    const audioPath = await createFakeAudio();

    const result = await transcribeAudio({
      baseUrl: "http://mac-asr.local:8000",
      model: "test-model",
      filePath: audioPath,
      fetchImpl: (async () => Response.json({ text: "只有纯文本" })) as typeof fetch
    });

    expect(result).toEqual({ text: "只有纯文本", segments: [] });
  });

  it("throws on network and HTTP failures", async () => {
    const audioPath = await createFakeAudio();

    await expect(
      transcribeAudio({
        baseUrl: "http://mac-asr.local:8000",
        model: "test-model",
        filePath: audioPath,
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as typeof fetch
      })
    ).rejects.toThrow(/network down/u);

    await expect(
      transcribeAudio({
        baseUrl: "http://mac-asr.local:8000",
        model: "test-model",
        filePath: audioPath,
        fetchImpl: (async () => new Response("boom", { status: 503 })) as typeof fetch
      })
    ).rejects.toThrow(/HTTP 503/u);
  });
});

async function createFakeAudio(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "home-ktv-asr-client-"));
  const audioPath = join(dir, "audio.m4a");
  await writeFile(audioPath, Buffer.from("fake 16k mono m4a"));
  return audioPath;
}
