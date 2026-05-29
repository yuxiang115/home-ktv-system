import { describe, expect, it, vi } from "vitest";
import {
  HttpLlmStyleTaggerClient,
  LlmStyleTagger,
  parseLlmStyleTagBatchResponse,
  parseLlmStyleTagResponse,
  type LlmStyleTaggerClient
} from "../modules/ktv-index/llm-style-tagger.js";

describe("LlmStyleTagger", () => {
  it("parses fenced JSON and keeps only whitelisted unique tags", () => {
    const tags = parseLlmStyleTagResponse(
      "```json\n{\"tags\":[\"华语\",\"流行\",\"不存在\",\"华语\",\"情歌\",\"KTV必点\",\"经典老歌\",\"怀旧\",\"90后\"]}\n```",
      6
    );

    expect(tags).toEqual(["华语", "流行", "情歌", "KTV必点", "经典老歌", "怀旧"]);
  });

  it("tags a song through a client without storing verbose model reasoning", async () => {
    const client: LlmStyleTaggerClient = {
      complete: vi.fn(async () => "{\"tags\":[\"华语\",\"民谣\",\"思乡\"]}")
    };
    const tagger = new LlmStyleTagger({ client, model: "local-model" });

    const result = await tagger.tagSong({ id: "song-1", title: "故乡", artistName: "许巍" });

    expect(result.tags).toEqual([
      { tag: "华语", confidence: 0.72, evidence: ["llm-style-v1:tag"] },
      { tag: "民谣", confidence: 0.72, evidence: ["llm-style-v1:tag"] },
      { tag: "思乡", confidence: 0.72, evidence: ["llm-style-v1:tag"] }
    ]);
    expect(result.evidence).toEqual({
      source: "llm-style-v1",
      model: "local-model",
      tagCount: 3
    });
  });

  it("parses a batch response by stable song id", () => {
    const results = parseLlmStyleTagBatchResponse(
      "{\"results\":[{\"id\":\"song-1\",\"tags\":[\"华语\",\"流行\",\"不存在\"]},{\"id\":\"song-2\",\"tags\":[\"粤语\",\"经典老歌\"]}]}",
      [
        { id: "song-1", title: "七里香", artistName: "周杰伦" },
        { id: "song-2", title: "海阔天空", artistName: "Beyond" }
      ],
      6
    );

    expect(results.get("song-1")).toEqual(["华语", "流行"]);
    expect(results.get("song-2")).toEqual(["粤语", "经典老歌"]);
  });

  it("rejects a malformed batch response so the whole batch can be retried", () => {
    expect(() => parseLlmStyleTagBatchResponse(
      "{\"results\":[{\"id\":\"song-1\",\"tags\":[\"华语\"]}]}",
      [
        { id: "song-1", title: "七里香", artistName: "周杰伦" },
        { id: "song-2", title: "海阔天空", artistName: "Beyond" }
      ],
      6
    )).toThrow("missing result for song id song-2");
  });

  it("tags a batch of songs with a single client request", async () => {
    const client: LlmStyleTaggerClient = {
      complete: vi.fn(async () => "{\"results\":[{\"id\":\"1\",\"tags\":[\"华语\",\"流行\"]},{\"id\":\"2\",\"tags\":[\"粤语\"]}]}")
    };
    const tagger = new LlmStyleTagger({ client, model: "local-model" });

    const results = await tagger.tagSongs([
      { id: "song-1", title: "七里香", artistName: "周杰伦" },
      { id: "song-2", title: "海阔天空", artistName: "Beyond" }
    ]);

    expect(client.complete).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(client.complete).mock.calls[0]![0].userPrompt;
    expect(prompt).toContain("\"id\":\"1\"");
    expect(prompt).toContain("\"id\":\"2\"");
    expect(prompt).not.toContain("\"id\":\"song-1\"");
    expect(prompt).not.toContain("\"id\":\"song-2\"");
    expect(results.get("song-1")?.tags.map((tag) => tag.tag)).toEqual(["华语", "流行"]);
    expect(results.get("song-2")?.tags.map((tag) => tag.tag)).toEqual(["粤语"]);
  });

  it("calls an OpenAI-compatible chat completions endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "{\"tags\":[\"流行\"]}" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new HttpLlmStyleTaggerClient({
        apiKey: "test-key",
        baseUrl: "http://llm.local:8317",
        model: "local-model"
      });

      await expect(client.complete({ systemPrompt: "system", userPrompt: "user" })).resolves.toBe("{\"tags\":[\"流行\"]}");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://llm.local:8317/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer test-key",
            "content-type": "application/json",
            "user-agent": "HomeKTVStyleTagger/0.1"
          })
        })
      );
      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "local-model",
        max_tokens: 96,
        temperature: 0.1
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
