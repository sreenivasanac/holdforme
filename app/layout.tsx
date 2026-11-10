import "./globals.css";
import type { Metadata, Viewport } from "next";
import { APP_NAME, TAGLINE } from "@/lib/config";

export const metadata: Metadata = {
  title: APP_NAME,
  description: `${TAGLINE} An AI agent that calls customer support for you, gets through the menu and the hold, and then finishes the call or hands the human to you.`,
};
export const viewport: Viewport = { themeColor: "#0b1020", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
