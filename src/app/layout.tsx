import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Knovelta · 让知识慢慢生长",
  description: "你的个人知识工作台。自然记录，审阅变更，让每一篇笔记都有来处。",
  applicationName: "Knovelta",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f8f9f5" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
