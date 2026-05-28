import { createHash } from "node:crypto";

export interface KtvStyleTaxonomyGroup {
  id: string;
  name: string;
  sortOrder: number;
  tags: readonly string[];
}

export const ktvStyleTaxonomy = [
  {
    id: "language-region",
    name: "语种地区",
    sortOrder: 10,
    tags: ["国语", "粤语", "闽南语", "客家语", "英语", "日语", "韩语", "华语", "内地", "港台", "港乐", "台语"]
  },
  {
    id: "core-genre",
    name: "核心曲风",
    sortOrder: 20,
    tags: [
      "流行",
      "华语流行",
      "粤语流行",
      "摇滚",
      "流行摇滚",
      "另类摇滚",
      "独立摇滚",
      "民谣",
      "校园民谣",
      "民歌",
      "民族",
      "民族流行",
      "草原",
      "R&B",
      "灵魂乐",
      "说唱",
      "电子",
      "流行舞曲",
      "舞曲",
      "DJ",
      "迪斯科",
      "浩室",
      "放克",
      "爵士",
      "布鲁斯",
      "古典",
      "轻音乐",
      "器乐",
      "新世纪",
      "戏曲",
      "京剧",
      "黄梅戏",
      "越剧",
      "儿歌",
      "童谣",
      "宗教/佛乐"
    ]
  },
  {
    id: "mood-theme",
    name: "主题情绪",
    sortOrder: 30,
    tags: [
      "情歌",
      "甜蜜",
      "浪漫",
      "伤感",
      "失恋",
      "思念",
      "孤独",
      "治愈",
      "励志",
      "热血",
      "青春回忆",
      "怀旧",
      "亲情",
      "友情",
      "友情/兄弟",
      "爱国",
      "红歌/革命歌曲",
      "军旅",
      "思乡",
      "校园",
      "婚礼",
      "离别",
      "励志合唱"
    ]
  },
  {
    id: "ktv-scene",
    name: "KTV场景",
    sortOrder: 40,
    tags: [
      "KTV必点",
      "经典老歌",
      "冷门佳曲",
      "热门",
      "对唱",
      "合唱",
      "女生",
      "男声",
      "女声",
      "高音",
      "低音",
      "容易唱",
      "飙歌",
      "广场舞",
      "车载",
      "运动/节奏",
      "酒吧",
      "晚会",
      "春晚",
      "生日歌",
      "喜庆/节日",
      "婚礼歌曲",
      "影视金曲",
      "动漫/ACG"
    ]
  },
  {
    id: "era-version",
    name: "年代版本",
    sortOrder: 50,
    tags: [
      "50/60年代",
      "70/80年代",
      "80/90年代",
      "70后",
      "80后",
      "90后",
      "00后",
      "00年代",
      "10年代",
      "20年代",
      "现场/演唱会",
      "Live",
      "DJ版",
      "翻唱",
      "怀旧金曲",
      "网络歌曲"
    ]
  }
] as const satisfies readonly KtvStyleTaxonomyGroup[];

export const allowedKtvStyleTags: ReadonlySet<string> = new Set<string>(ktvStyleTaxonomy.flatMap((group) => group.tags));

export function isAllowedKtvStyleTag(tag: string): boolean {
  return allowedKtvStyleTags.has(tag);
}

export function normalizeKtvStyleTagName(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

export function ktvStyleTagId(tag: string): string {
  const hash = createHash("sha1").update(tag).digest("hex").slice(0, 16);
  return `style-tag-${hash}`;
}
