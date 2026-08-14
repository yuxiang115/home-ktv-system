import type { StageExecuteInput, StageExecuteResult, StageHandler } from "../supplement-orchestrator.js";

export interface RenameLlmHandlerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `你是一个 KTV 曲库文件名规整助手。给定一个在线视频标题,提取歌手、歌名、语种与分类,输出符合 "歌手-歌名-语种-分类" 的规范名(不含扩展名)。
规则:
- 语种只能是:国语|粤语|闽南语|英语|日语|韩语|其他 之一。
- 分类建议在 流行|经典|摇滚|民谣|舞曲|喜庆|其他 中选最贴近的。
- 歌手名或歌名内部如果出现空格,用下划线 "_" 连接,确保整体只用 "-" 切成四段。
- 去掉标题里的 "Official MV"、"官方MV"、"MV"、"【】"、"[4K]"、"(1080P)" 等装饰词。
- 只输出规范文件名这一行,不要解释、不要代码块。`;

export class RenameLlmStageHandler implements StageHandler {
  readonly stage = "rename" as const;

  constructor(private readonly options: RenameLlmHandlerOptions) {}

  async execute(input: StageExecuteInput): Promise<StageExecuteResult> {
    const fallback = fallbackSpecName(input.task.title, input.task.artistName);

    if (!this.options.apiKey) {
      return { status: "completed", message: "renamed (no LLM configured, fallback)", llmRenamedTitle: fallback };
    }

    const userPrompt = `视频标题:${input.task.title}${input.task.artistName ? `\n可能的歌手:${input.task.artistName}` : ""}`;

    let renamed: string;
    try {
      renamed = await this.callLlm(userPrompt);
    } catch (error) {
      return {
        status: "completed",
        message: `renamed (LLM error, fallback): ${error instanceof Error ? error.message : String(error)}`,
        llmRenamedTitle: fallback
      };
    }

    const cleaned = sanitizeSpecName(renamed);
    if (!cleaned) {
      return { status: "completed", message: "renamed (LLM empty, fallback)", llmRenamedTitle: fallback };
    }
    return { status: "completed", message: "renamed", llmRenamedTitle: cleaned };
  }

  private async callLlm(userPrompt: string): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2
      })
    });
    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}`);
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }
}

function sanitizeSpecName(value: string): string {
  // qwen3 等 thinking 模型会先输出 <think>...</think>,取闭合后的实际答案
  const thinkMatch = value.match(/<\/think>\s*([\s\S]*)$/u);
  const afterThink = thinkMatch ? (thinkMatch[1] ?? "").trim() : value;
  const trimmed = afterThink.replace(/\s+/gu, " ").trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/u);
  const inner = fenceMatch ? (fenceMatch[1] ?? "").trim() : trimmed;
  return inner.replace(/\.(mkv|mp4|mpg|mpeg)$/iu, "").trim();
}

// 无 LLM 时的兜底规范名。YouTube 中文 MV 标题极常见 "歌手【歌名】" / "歌手 - 歌名" 模式,
// 优先按结构提取,保持与曲库 "歌手-歌名-语种-分类" 命名 pattern 一致。
export function fallbackSpecName(title: string, artistName: string): string {
  const structured = extractStructuredArtistTitle(title);

  const cleaned = (structured?.title ?? title)
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)/gu, "")
    .replace(/\b(official|music video|mv|hd|4k|1080p)\b/giu, "")
    .replace(/官方|高清|完整版|正式版/gu, "")
    .replace(/[-—–]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[-\s]+|[-\s]+$/gu, "");

  const rawArtist = structured?.artist?.trim() || artistName.trim() || "Unknown";
  const artist = rawArtist.replace(/[\s-]+/gu, "_");
  const song = (cleaned || title).replace(/[\s-]+/gu, "_");
  return `${artist}-${song}-其他-流行`;
}

function extractStructuredArtistTitle(title: string): { artist: string | null; title: string | null } | null {
  // 模式1: "薛之謙 Joker Xue【演員】Official Music Video" → artist=薛之謙 Joker Xue, title=演員
  const bracket = title.match(/^(.+?)【([^】]+)】/u);
  if (bracket?.[1]?.trim() && bracket[2]?.trim()) {
    return { artist: bracket[1].trim(), title: bracket[2].trim() };
  }

  // 模式2: "周杰倫 Jay Chou - 晴天 (Official MV)" → artist=周杰倫 Jay Chou, title=晴天
  const dash = title.match(/^(.{1,40}?)\s*[-–—]\s*(.{1,60})$/u);
  if (dash?.[1]?.trim() && dash[2]?.trim() && !/official|mv|video/iu.test(dash[1])) {
    return { artist: dash[1].trim(), title: dash[2].trim() };
  }

  return null;
}
