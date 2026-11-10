import "./globals.css";
import { APP_NAME, TAGLINE } from "@/lib/config";

export const metadata = { title: APP_NAME, description: TAGLINE };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
