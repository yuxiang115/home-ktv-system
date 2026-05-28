import { isAllowedKtvStyleTag } from "./style-taxonomy.js";

export interface KtvStyleTagEvidence {
  tag: string;
  confidence: number;
  evidence: readonly string[];
}

export interface KtvStyleTaggerResult {
  tags: KtvStyleTagEvidence[];
  evidence: Record<string, unknown>;
}

export interface NeteaseStyleTaggerInput {
  title: string;
  artistName: string;
}

interface NeteaseSongCandidate {
  id?: number;
  name?: string;
  ar?: Array<{ name?: string }>;
  al?: { name?: string };
  alia?: string[];
}

interface NeteasePlaylistCandidate {
  id?: number;
  name?: string;
  tags?: string[];
  trackCount?: number;
  playCount?: number;
  bookCount?: number;
  _query?: string;
}

interface NeteasePlaylistDetail {
  id?: number;
  query?: string;
  name?: string;
  tags?: string[];
  trackCount?: number;
  playCount?: number;
  subscribedCount?: number;
}

export interface NeteaseStyleTaggerClient {
  searchSongs(input: { keywords: string; limit: number }): Promise<NeteaseSongCandidate[]>;
  searchPlaylists(input: { keywords: string; limit: number }): Promise<NeteasePlaylistCandidate[]>;
  getPlaylistDetail(id: number): Promise<NeteasePlaylistDetail | null>;
}

export interface NeteaseStyleTaggerOptions {
  client: NeteaseStyleTaggerClient;
  maxTags?: number;
  playlistSearchLimit?: number;
  playlistDetailLimit?: number;
}

const directTagMap = new Map<string, string>([
  ["华语", "华语"],
  ["国语", "国语"],
  ["中文", "华语"],
  ["粤语", "粤语"],
  ["闽南语", "闽南语"],
  ["闽南", "闽南语"],
  ["客家语", "客家语"],
  ["台语", "台语"],
  ["港乐", "港乐"],
  ["流行", "流行"],
  ["摇滚", "摇滚"],
  ["另类/独立", "独立摇滚"],
  ["民谣", "民谣"],
  ["民歌", "民歌"],
  ["民族", "民族"],
  ["怀旧", "怀旧"],
  ["浪漫", "浪漫"],
  ["经典", "经典老歌"],
  ["80后", "80后"],
  ["90后", "90后"],
  ["70后", "70后"],
  ["00后", "00后"],
  ["儿童", "儿歌"],
  ["儿歌", "儿歌"],
  ["ACG", "动漫/ACG"],
  ["动漫", "动漫/ACG"],
  ["影视", "影视金曲"],
  ["轻音乐", "轻音乐"],
  ["爵士", "爵士"],
  ["电子", "电子"],
  ["说唱", "说唱"],
  ["古典", "古典"],
  ["治愈", "治愈"],
  ["清新", "治愈"],
  ["孤独", "孤独"],
  ["快乐", "甜蜜"]
]);

const keywordRules: Array<[string, string]> = [
  ["粤语", "粤语"],
  ["广东歌", "粤语"],
  ["港乐", "粤语"],
  ["国语", "国语"],
  ["闽南语", "闽南语"],
  ["闽南", "闽南语"],
  ["台语", "台语"],
  ["华语", "华语"],
  ["中文", "华语"],
  ["经典", "经典老歌"],
  ["老歌", "经典老歌"],
  ["金曲", "经典老歌"],
  ["怀旧金曲", "怀旧金曲"],
  ["怀旧", "怀旧"],
  ["回忆", "怀旧"],
  ["青春", "青春回忆"],
  ["8090", "80/90年代"],
  ["7080", "70/80年代"],
  ["5060", "50/60年代"],
  ["00后", "00年代"],
  ["10后", "10年代"],
  ["80后", "80后"],
  ["90后", "90后"],
  ["KTV", "KTV必点"],
  ["ktv", "KTV必点"],
  ["必点", "KTV必点"],
  ["点歌", "KTV必点"],
  ["冷门", "冷门佳曲"],
  ["热门", "热门"],
  ["情歌", "情歌"],
  ["伤感", "伤感"],
  ["失恋", "失恋"],
  ["治愈", "治愈"],
  ["浪漫", "浪漫"],
  ["励志", "励志"],
  ["热血", "热血"],
  ["思念", "思念"],
  ["孤独", "孤独"],
  ["校园", "校园"],
  ["婚礼", "婚礼"],
  ["摇滚", "摇滚"],
  ["流行摇滚", "流行摇滚"],
  ["独立摇滚", "独立摇滚"],
  ["另类摇滚", "另类摇滚"],
  ["民谣", "民谣"],
  ["校园民谣", "校园民谣"],
  ["民歌", "民歌"],
  ["民族", "民族"],
  ["民族风", "民族流行"],
  ["草原", "草原"],
  ["军旅", "军旅"],
  ["红歌", "红歌/革命歌曲"],
  ["革命", "红歌/革命歌曲"],
  ["广场舞", "广场舞"],
  ["舞曲", "舞曲"],
  ["DJ", "DJ"],
  ["dj", "DJ"],
  ["DJ版", "DJ版"],
  ["电音", "电子"],
  ["电子", "电子"],
  ["R&B", "R&B"],
  ["r&b", "R&B"],
  ["说唱", "说唱"],
  ["爵士", "爵士"],
  ["布鲁斯", "布鲁斯"],
  ["轻音乐", "轻音乐"],
  ["车载", "车载"],
  ["跑步", "运动/节奏"],
  ["节奏", "运动/节奏"],
  ["酒吧", "酒吧"],
  ["晚会", "晚会"],
  ["春晚", "春晚"],
  ["超嗨", "飙歌"],
  ["高音", "高音"],
  ["女声", "女声"],
  ["男声", "男声"],
  ["儿歌", "儿歌"],
  ["宝宝", "儿歌"],
  ["幼儿园", "儿歌"],
  ["儿童", "儿歌"],
  ["童谣", "童谣"],
  ["影视", "影视金曲"],
  ["电视剧", "影视金曲"],
  ["电影", "影视金曲"],
  ["主题曲", "影视金曲"],
  ["插曲", "影视金曲"],
  ["OST", "影视金曲"],
  ["ost", "影视金曲"],
  ["对唱", "对唱"],
  ["合唱", "合唱"],
  ["男女", "对唱"],
  ["演唱会", "现场/演唱会"],
  ["现场", "现场/演唱会"],
  ["live", "现场/演唱会"],
  ["Live", "现场/演唱会"],
  ["翻唱", "翻唱"],
  ["网络歌曲", "网络歌曲"]
];

const titleKeywordRules: Array<[string, string]> = [
  ["生日", "生日歌"],
  ["祝寿", "生日歌"],
  ["新年", "喜庆/节日"],
  ["过年", "喜庆/节日"],
  ["恭喜", "喜庆/节日"],
  ["发财", "喜庆/节日"],
  ["好运来", "喜庆/节日"],
  ["妈妈", "亲情"],
  ["母亲", "亲情"],
  ["父亲", "亲情"],
  ["爸爸", "亲情"],
  ["兄弟", "友情/兄弟"],
  ["朋友", "友情"],
  ["祖国", "红歌/革命歌曲"],
  ["中国", "红歌/革命歌曲"],
  ["毛主席", "红歌/革命歌曲"],
  ["共产党", "红歌/革命歌曲"],
  ["军中", "军旅"],
  ["军营", "军旅"],
  ["军歌", "军旅"],
  ["参军", "军旅"],
  ["战士", "军旅"],
  ["草原", "草原"],
  ["蒙古", "民族"],
  ["天路", "民族"],
  ["康定", "民歌"],
  ["分手", "失恋"],
  ["眼泪", "伤感"],
  ["心痛", "伤感"],
  ["伤心", "伤感"],
  ["寂寞", "孤独"],
  ["孤单", "孤独"],
  ["孤独", "孤独"],
  ["思念", "思念"],
  ["故乡", "思乡"],
  ["家乡", "思乡"],
  ["想你", "情歌"],
  ["爱你", "情歌"],
  ["情人", "情歌"],
  ["恋人", "情歌"],
  ["爱情", "情歌"],
  ["月亮代表我的心", "情歌"],
  ["甜蜜蜜", "甜蜜"],
  ["相信", "励志"],
  ["勇敢", "励志"],
  ["飞翔", "励志"],
  ["海阔天空", "励志"],
  ["小苹果", "广场舞"],
  ["最炫民族风", "广场舞"],
  ["自由飞翔", "广场舞"],
  ["童话", "青春回忆"],
  ["同桌的你", "校园"],
  ["主题曲", "影视金曲"],
  ["片尾曲", "影视金曲"],
  ["插曲", "影视金曲"]
];

export class NeteaseStyleTagger {
  constructor(private readonly options: NeteaseStyleTaggerOptions) {}

  async tagSong(input: NeteaseStyleTaggerInput): Promise<KtvStyleTaggerResult> {
    const playlistSearchLimit = this.options.playlistSearchLimit ?? 5;
    const playlistDetailLimit = this.options.playlistDetailLimit ?? 8;
    const maxTags = this.options.maxTags ?? 8;
    const songCandidates = await this.options.client.searchSongs({
      keywords: `${input.artistName} ${input.title}`,
      limit: 8
    });
    const playlists = await this.searchPlaylists(input, playlistSearchLimit);
    const playlistDetails = await this.fetchPlaylistDetails(playlists, playlistDetailLimit);
    const tags = collectTagEvidence(input, playlistDetails).slice(0, maxTags);

    return {
      tags,
      evidence: {
        neteaseSongCandidates: compactSongCandidates(songCandidates),
        playlistEvidence: playlistDetails.slice(0, playlistDetailLimit)
      }
    };
  }

  private async searchPlaylists(input: NeteaseStyleTaggerInput, limit: number): Promise<NeteasePlaylistCandidate[]> {
    const seen = new Set<number>();
    const playlists: NeteasePlaylistCandidate[] = [];
    for (const query of playlistQueries(input.artistName, input.title)) {
      const rows = await this.options.client.searchPlaylists({ keywords: query, limit });
      for (const row of rows) {
        if (typeof row.id !== "number" || seen.has(row.id)) {
          continue;
        }
        seen.add(row.id);
        playlists.push({ ...row, _query: query });
      }
    }
    return playlists;
  }

  private async fetchPlaylistDetails(
    playlists: readonly NeteasePlaylistCandidate[],
    limit: number
  ): Promise<NeteasePlaylistDetail[]> {
    const rows: NeteasePlaylistDetail[] = [];
    for (const playlist of playlists.slice(0, limit)) {
      if (typeof playlist.id !== "number") {
        continue;
      }
      const detail = await this.options.client.getPlaylistDetail(playlist.id);
      const row: NeteasePlaylistDetail = {
        id: playlist.id,
        tags: detail?.tags ?? playlist.tags ?? []
      };
      const query = playlist._query;
      const name = detail?.name ?? playlist.name;
      const trackCount = detail?.trackCount ?? playlist.trackCount;
      const playCount = detail?.playCount ?? playlist.playCount;
      const subscribedCount = detail?.subscribedCount ?? playlist.bookCount;
      if (query !== undefined) {
        row.query = query;
      }
      if (name !== undefined) {
        row.name = name;
      }
      if (trackCount !== undefined) {
        row.trackCount = trackCount;
      }
      if (playCount !== undefined) {
        row.playCount = playCount;
      }
      if (subscribedCount !== undefined) {
        row.subscribedCount = subscribedCount;
      }
      rows.push(row);
    }
    return rows;
  }
}

export class HttpNeteaseStyleTaggerClient implements NeteaseStyleTaggerClient {
  private lastRequestAt = 0;

  constructor(
    private readonly input: {
      baseUrl: string;
      delayMs?: number;
      timeoutMs?: number;
    }
  ) {}

  async searchSongs(input: { keywords: string; limit: number }): Promise<NeteaseSongCandidate[]> {
    const data = await this.get("/cloudsearch", { keywords: input.keywords, type: 1, limit: input.limit });
    return Array.isArray(data?.result?.songs) ? data.result.songs : [];
  }

  async searchPlaylists(input: { keywords: string; limit: number }): Promise<NeteasePlaylistCandidate[]> {
    const data = await this.get("/cloudsearch", { keywords: input.keywords, type: 1000, limit: input.limit });
    return Array.isArray(data?.result?.playlists) ? data.result.playlists : [];
  }

  async getPlaylistDetail(id: number): Promise<NeteasePlaylistDetail | null> {
    const data = await this.get("/playlist/detail", { id });
    return isRecord(data?.playlist) ? data.playlist as NeteasePlaylistDetail : null;
  }

  private async get(path: string, params: Record<string, string | number>): Promise<Record<string, any>> {
    const delayMs = this.input.delayMs ?? 250;
    const elapsedMs = Date.now() - this.lastRequestAt;
    if (elapsedMs < delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs - elapsedMs));
    }
    this.lastRequestAt = Date.now();

    const url = new URL(path, this.input.baseUrl.endsWith("/") ? this.input.baseUrl : `${this.input.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.input.timeoutMs ?? 20_000);
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "HomeKTVStyleTagger/0.1" },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Netease API HTTP ${response.status}`);
      }
      return await response.json() as Record<string, any>;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function playlistQueries(artistName: string, title: string): string[] {
  return [
    `${artistName} ${title}`,
    title,
    `${title} KTV`,
    `${artistName} 经典`,
    `${artistName} ${title} 歌单`
  ];
}

function collectTagEvidence(input: NeteaseStyleTaggerInput, playlists: readonly NeteasePlaylistDetail[]): KtvStyleTagEvidence[] {
  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();

  for (const [keyword, tag] of titleKeywordRules) {
    if (input.title.includes(keyword)) {
      addTagEvidence(scores, evidence, tag, 2, `title.keyword:${keyword}`);
    }
  }

  for (const playlist of playlists) {
    const name = playlist.name ?? "";
    for (const rawTag of playlist.tags ?? []) {
      const tag = directTagMap.get(rawTag);
      if (tag) {
        addTagEvidence(scores, evidence, tag, 4, `playlist.tag:${rawTag} <${name}>`);
      }
    }
    for (const [keyword, tag] of keywordRules) {
      if (name.includes(keyword)) {
        addTagEvidence(scores, evidence, tag, 2, `playlist.name:${keyword} <${name}>`);
      }
    }
  }

  return Array.from(scores.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hans-CN"))
    .map(([tag, score]) => ({
      tag,
      confidence: Math.min(1, Math.max(0.35, score / 16)),
      evidence: evidence.get(tag)?.slice(0, 5) ?? []
    }));
}

function addTagEvidence(
  scores: Map<string, number>,
  evidence: Map<string, string[]>,
  tag: string,
  score: number,
  source: string
): void {
  if (!isAllowedKtvStyleTag(tag)) {
    return;
  }
  scores.set(tag, (scores.get(tag) ?? 0) + score);
  evidence.set(tag, [...(evidence.get(tag) ?? []), source]);
}

function compactSongCandidates(candidates: readonly NeteaseSongCandidate[]): Array<Record<string, unknown>> {
  return candidates.slice(0, 5).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    artists: candidate.ar?.map((artist) => artist.name).filter(Boolean) ?? [],
    album: candidate.al?.name,
    aliases: candidate.alia ?? []
  }));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
