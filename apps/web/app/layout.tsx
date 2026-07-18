import type { Metadata, Viewport } from "next";
import "./globals.css";
import TabBar from "../components/TabBar.js";

export const metadata: Metadata = {
  title: "Turtle Trading",
  description: "터틀 트레이딩 시그널 시스템",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b0e14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <main className="main">{children}</main>
        <TabBar />
      </body>
    </html>
  );
}
