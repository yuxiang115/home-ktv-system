import { describe, expect, it } from "vitest";
import {
  buildSongTitleCleanupPlan,
  parseCleanSongTitleMetadataOptions
} from "../scripts/clean-song-title-metadata.js";

describe("clean song title metadata CLI", () => {
  it("defaults to dry-run and reads DATABASE_URL from env", () => {
    const options = parseCleanSongTitleMetadataOptions([], {
      DATABASE_URL: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });

    expect(options).toMatchObject({
      apply: false,
      databaseUrl: "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"
    });
  });

  it("builds cleanup plans for dirty titles and stale normalized titles", () => {
    const plan = buildSongTitleCleanupPlan([
      {
        id: "song-1",
        title: "酒干倘卖无(蒙面歌王)流行",
        normalized_title: "酒干倘卖无蒙面歌王流行",
        primary_artist_name: "李克勤",
        artist_names: ["李克勤"],
        relative_path: "国语-知名歌星专辑 11000首850G/知名歌星个人专辑（65人6600首）/李克勤（国语21）/李克勤-酒干倘卖无(蒙面歌王)流行-国语-流行.mpg"
      },
      {
        id: "song-2",
        title: "爆发",
        normalized_title: "经曲老歌3",
        primary_artist_name: "陈小春",
        artist_names: ["陈小春"],
        relative_path: "经典老歌(1.2万首450G)/经曲老歌3/陈小春-爆发-国语-流行歌曲.mkv"
      },
      {
        id: "song-3",
        title: "如果这就是爱情[720高清]",
        normalized_title: "如果这就是爱情720高清",
        primary_artist_name: "张靓颖",
        artist_names: ["张靓颖"],
        relative_path: "综合专辑 9300首1.4T/K歌排行/70后/张靓颖-如果这就是爱情[720高清]-国语-流行.mpg"
      },
      {
        id: "song-4",
        title: "不够成熟[2]",
        normalized_title: "不够成熟2",
        primary_artist_name: "汪苏泷",
        artist_names: ["汪苏泷"],
        relative_path: "综合专辑 9300首1.4T/K歌排行/90后/汪苏泷-不够成熟[2]-国语-流行.mpg"
      },
      {
        id: "song-5",
        title: "手心里的温柔[R]",
        normalized_title: "手心里的温柔r",
        primary_artist_name: "刀郎",
        artist_names: ["刀郎"],
        relative_path: "国语-知名歌星专辑 11000首850G/刀郎（国语50）/刀郎-手心里的温柔[R]-国语-流行.mpg"
      },
      {
        id: "song-6",
        title: "不忘初心 (2017春晚版)",
        normalized_title: "不忘初心2017春晚版",
        primary_artist_name: "韩磊",
        artist_names: ["韩磊"],
        relative_path: "2024/2024-01/韩磊_谭维维-不忘初心 (2017春晚版)-国语-流行.mkv"
      },
      {
        id: "song-7",
        title: "领悟〖演唱会〗",
        normalized_title: "领悟演唱会",
        primary_artist_name: "辛晓琪",
        artist_names: ["辛晓琪"],
        relative_path: "经典老歌(1.2万首450G)/经典老歌1/辛晓琪-领悟〖演唱会〗-国语-流行.mkv"
      }
    ]);

    expect(plan).toHaveLength(7);
    expect(plan[0]).toMatchObject({
      id: "song-1",
      title: "酒干倘卖无",
      previousTitle: "酒干倘卖无(蒙面歌王)流行",
      normalizedTitle: "酒干倘卖无"
    });
    expect(plan[1]).toMatchObject({
      id: "song-2",
      title: "爆发",
      previousNormalizedTitle: "经曲老歌3",
      normalizedTitle: "爆发"
    });
    expect(plan[2]).toMatchObject({
      id: "song-3",
      title: "这就是爱情",
      previousTitle: "如果这就是爱情[720高清]",
      normalizedTitle: "这就是爱情"
    });
    expect(plan[3]).toMatchObject({
      id: "song-4",
      title: "不够成熟",
      previousTitle: "不够成熟[2]",
      normalizedTitle: "不够成熟"
    });
    expect(plan[4]).toMatchObject({
      id: "song-5",
      title: "手心里的温柔",
      previousTitle: "手心里的温柔[R]",
      normalizedTitle: "手心里的温柔"
    });
    expect(plan[5]).toMatchObject({
      id: "song-6",
      title: "不忘初心",
      previousTitle: "不忘初心 (2017春晚版)",
      normalizedTitle: "不忘初心"
    });
    expect(plan[6]).toMatchObject({
      id: "song-7",
      title: "领悟",
      previousTitle: "领悟〖演唱会〗",
      normalizedTitle: "领悟"
    });
  });

  it("re-parses title and artist metadata from the stored relative path", () => {
    const plan = buildSongTitleCleanupPlan([
      {
        id: "song-1",
        title: "经典老歌3",
        normalized_title: "经典老歌3",
        primary_artist_name: "Unknown Artist",
        artist_names: ["Unknown Artist"],
        relative_path: "经典老歌(1.2万首450G)/经曲老歌3/陈小春-爆发-国语-流行歌曲.mkv"
      },
      {
        id: "song-2",
        title: "时代曲",
        normalized_title: "202511",
        primary_artist_name: "2025",
        artist_names: ["2025"],
        relative_path: "2025/2025-11/陈奕迅-时代曲-粤语-流行.mkv"
      }
    ]);

    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      id: "song-1",
      title: "爆发",
      normalizedTitle: "爆发",
      primaryArtistName: "陈小春",
      artistNames: ["陈小春"]
    });
    expect(plan[1]).toMatchObject({
      id: "song-2",
      title: "时代曲",
      normalizedTitle: "时代曲",
      primaryArtistName: "陈奕迅",
      artistNames: ["陈奕迅"]
    });
  });
});
