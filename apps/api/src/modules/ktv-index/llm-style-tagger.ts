import { isAllowedKtvStyleTag, ktvStyleTaxonomy } from "./style-taxonomy.js";
import type { KtvStyleTaggerResult } from "./netease-style-tagger.js";
import type { KtvStyleTaggingSong } from "./ktv-style-tagging-service.js";

export interface LlmStyleTaggerClient {
  complete(input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

export interface LlmStyleTaggerOptions {
  client: LlmStyleTaggerClient;
  model: string;
  maxTags?: number;
}

export interface HttpLlmStyleTaggerClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class LlmStyleTagger {
  constructor(private readonly options: LlmStyleTaggerOptions) {}

  async tagSong(song: KtvStyleTaggingSong): Promise<KtvStyleTaggerResult> {
    const content = await this.options.client.complete({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(song)
    });
    const tags = parseLlmStyleTagResponse(content, this.options.maxTags ?? 6);

    return {
      tags: tags.map((tag) => ({
        tag,
        confidence: 0.72,
        evidence: ["llm-style-v1:tag"]
      })),
      evidence: {
        source: "llm-style-v1",
        model: this.options.model,
        tagCount: tags.length
      }
    };
  }
}

export class HttpLlmStyleTaggerClient implements LlmStyleTaggerClient {
  constructor(private readonly options: HttpLlmStyleTaggerClientOptions) {}

  async complete(input: { systemPrompt: string; userPrompt: string }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const response = await fetch(resolveChatCompletionsUrl(this.options.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          "user-agent": "HomeKTVStyleTagger/0.1"
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt }
          ],
          temperature: 0.1,
          max_tokens: this.options.maxTokens ?? 96,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`LLM API HTTP ${response.status}`);
      }

      const data = await response.json() as Record<string, any>;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("LLM API response did not include message content");
      }
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseLlmStyleTagResponse(content: string, maxTags = 6): string[] {
  const jsonText = extractJsonObject(content);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const rawTags = Array.isArray(parsed.tags)
    ? parsed.tags
    : Array.isArray(parsed.styleTags)
      ? parsed.styleTags
      : [];
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const rawTag of rawTags) {
    if (typeof rawTag !== "string") {
      continue;
    }
    const tag = rawTag.trim();
    if (!isAllowedKtvStyleTag(tag) || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= maxTags) {
      break;
    }
  }

  return tags;
}

function buildSystemPrompt(): string {
  const taxonomy = ktvStyleTaxonomy
    .map((group) => `${group.name}: ${group.tags.join("、")}`)
    .join("\n");
  return [
    "你是家庭 KTV 曲库标签助手。",
    "只能从给定白名单中选择标签，不能创造新标签。",
    "根据歌名和歌手判断语种、曲风、情绪、KTV场景和年代版本。",
    "最多返回 6 个标签，优先选择对点歌筛选有用的标签。",
    "只输出 JSON，格式为 {\"tags\":[\"标签1\",\"标签2\"]}。",
    "",
    taxonomy
  ].join("\n");
}

function buildUserPrompt(song: KtvStyleTaggingSong): string {
  return [
    `歌名: ${song.title}`,
    `歌手: ${song.artistName}`,
    "请返回适合这首歌的 KTV 曲库标签。"
  ].join("\n");
}

function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  if (fenced) {
    return fenced;
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return content.slice(start, end + 1);
  }
  return content.trim();
}

function resolveChatCompletionsUrl(rawBaseUrl: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(rawBaseUrl) ? rawBaseUrl : `http://${rawBaseUrl}`;
  const url = new URL(withScheme.endsWith("/") ? withScheme : `${withScheme}/`);
  const path = url.pathname.replace(/\/+$/u, "");

  if (path.endsWith("/chat/completions")) {
    url.pathname = path;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = `${path}/v1/chat/completions`;
  }

  return url.toString();
}
