import Parser from "rss-parser";
import type { Repo } from "@turtle/db";
import { fmtNews, type TelegramSender } from "./telegram.js";

export interface RssSource {
  name: string;
  url: string;
}

export const DEFAULT_SOURCES: RssSource[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  {
    name: "GoogleNews-Macro",
    url: "https://news.google.com/rss/search?q=%EC%97%B0%EC%A4%80%20OR%20%EA%B8%88%EB%A6%AC%20OR%20%EA%B4%80%EC%84%B8&hl=ko&gl=KR&ceid=KR:ko",
  },
  {
    name: "GoogleNews-Geo",
    url: "https://news.google.com/rss/search?q=%ED%8A%B8%EB%9F%BC%ED%94%84%20OR%20%EC%A7%80%EC%A0%95%ED%95%99&hl=ko&gl=KR&ceid=KR:ko",
  },
];

export const DEFAULT_KEYWORDS = [
  "트럼프",
  "Trump",
  "관세",
  "tariff",
  "연준",
  "Fed",
  "FOMC",
  "금리",
  "전쟁",
  "지정학",
  "제재",
  "sanction",
];

export function matchKeywords(title: string, keywords: string[]): string[] {
  const lower = title.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

export interface RssDeps {
  repo: Repo;
  telegram: TelegramSender;
  sources?: RssSource[];
  fetchFeed?: (url: string) => Promise<{ title?: string; link?: string; isoDate?: string }[]>;
  log?: (msg: string) => void;
}

export async function pollRss(deps: RssDeps): Promise<void> {
  const { repo, telegram } = deps;
  const log = deps.log ?? (() => {});
  const sources = deps.sources ?? DEFAULT_SOURCES;
  const parser = new Parser({ timeout: 15_000 });
  const fetchFeed =
    deps.fetchFeed ??
    (async (url: string) => {
      const feed = await parser.parseURL(url);
      return feed.items ?? [];
    });

  const keywords = (repo.getSetting("newsKeywords") ?? DEFAULT_KEYWORDS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const alertsOn = repo.getSetting("notif:news") !== "off";

  for (const src of sources) {
    let items;
    try {
      items = await fetchFeed(src.url);
    } catch (e) {
      log(`rss fail ${src.name}: ${(e as Error).message}`);
      continue; // per-source isolation
    }
    for (const item of items.slice(0, 30)) {
      if (!item.title || !item.link) continue;
      const matched = matchKeywords(item.title, keywords);
      const id = repo.insertNews({
        source: src.name,
        title: item.title,
        link: item.link,
        pubDate: item.isoDate ? Date.parse(item.isoDate) : null,
        matched: matched.length > 0,
        keywords: matched,
      });
      if (id !== null && matched.length > 0 && alertsOn) {
        await telegram.send(fmtNews(src.name, item.title, item.link, matched));
      }
    }
  }
}
