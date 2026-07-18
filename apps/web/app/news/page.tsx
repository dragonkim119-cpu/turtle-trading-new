"use client";

import { useEffect, useState } from "react";

interface NewsItem {
  id: number;
  source: string;
  title: string;
  link: string;
  pubDate: number | null;
  matched: number;
  keywords: string;
  createdAt: number;
}

export default function NewsPage() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [tab, setTab] = useState<"news" | "calendar">("news");

  useEffect(() => {
    fetch("/api/news?limit=150")
      .then((r) => r.json())
      .then((d) => setNews(d.news ?? []));
  }, []);

  const matched = news.filter((n) => n.matched);
  const rest = news.filter((n) => !n.matched);

  return (
    <div>
      <div className="seg" style={{ margin: "12px 10px 0" }}>
        <button className={tab === "news" ? "on" : ""} onClick={() => setTab("news")}>
          📰 뉴스·속보
        </button>
        <button className={tab === "calendar" ? "on" : ""} onClick={() => setTab("calendar")}>
          📅 경제 캘린더
        </button>
      </div>

      {tab === "calendar" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <iframe
            src="https://s.tradingview.com/embed-widget/events/?locale=kr#%7B%22colorTheme%22%3A%22dark%22%2C%22isTransparent%22%3Afalse%2C%22width%22%3A%22100%25%22%2C%22height%22%3A%22600%22%2C%22importanceFilter%22%3A%220%2C1%22%2C%22countryFilter%22%3A%22us%2Ckr%2Ccn%2Ceu%2Cjp%22%7D"
            style={{ width: "100%", height: 600, border: 0 }}
            title="경제 캘린더"
          />
        </div>
      )}

      {tab === "news" && (
        <>
          {matched.length > 0 && (
            <div className="card" style={{ borderColor: "var(--amber)" }}>
              <h2>🚨 키워드 속보</h2>
              {matched.slice(0, 20).map((n) => (
                <NewsRow key={n.id} n={n} />
              ))}
            </div>
          )}
          <div className="card">
            <h2>거시 뉴스</h2>
            {rest.length === 0 && <p className="muted">엔진이 10분마다 수집. 잠시 후 새로고침.</p>}
            {rest.slice(0, 80).map((n) => (
              <NewsRow key={n.id} n={n} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NewsRow({ n }: { n: NewsItem }) {
  return (
    <div className="list-item">
      <a href={n.link} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "var(--text)" }}>
        {n.matched === 1 && <span className="badge amber">{n.keywords}</span>} {n.title}
      </a>
      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        {n.source} · {new Date(n.pubDate ?? n.createdAt).toLocaleString("ko-KR")}
      </div>
    </div>
  );
}
