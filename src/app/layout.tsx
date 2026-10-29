import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "@/components/workspace.css";

export const metadata: Metadata = {
  title: "Knovelta · 个人知识工作台",
  description: "记录与查询个人知识，审阅变更，追溯来源与版本。",
  applicationName: "Knovelta",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f2f6fa" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
