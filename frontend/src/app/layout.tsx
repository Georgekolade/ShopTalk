import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import SwRegister from "./sw-register";
import { Shell } from "../components/nav";

// Fully self-hosted: woff2 files live in ./fonts, so no request ever
// leaves the server for fonts.googleapis.com / fonts.gstatic.com.
// latin-ext is included because ₦ (U+20A6, naira) lives in that subset.
const geistSans = localFont({
  src: [
    { path: "./fonts/geist-latin.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/geist-latinext.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = localFont({
  src: [
    { path: "./fonts/geist-mono-latin.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/geist-mono-latinext.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-geist-mono",
  display: "swap",
});

const fraunces = localFont({
  src: [
    { path: "./fonts/fraunces-latin.woff2", weight: "500 700", style: "normal" },
    { path: "./fonts/fraunces-latinext.woff2", weight: "500 700", style: "normal" },
  ],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ShopTalk AI",
  description: "Voice-and-text business operations for small businesses.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "ShopTalk" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#14532d",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <SwRegister />
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
