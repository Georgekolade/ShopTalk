/* Entry gate: sends each session to login, business select, or assistant. */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getBusinessId, getToken } from "../lib/api";

export default function Home() {
  const router = useRouter();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!getToken()) router.replace("/login");
    else if (getBusinessId() === null) router.replace("/businesses");
    else router.replace("/dashboard");
    const timer = setTimeout(() => setStuck(true), 4000);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="text-center">
        <p className="text-sm text-zinc-500">Loading ShopTalk…</p>
        {stuck ? (
          <p className="mt-3 text-sm text-zinc-600">
            Taking too long?{" "}
            <Link href="/login" className="font-semibold text-green-900 underline">
              Go to sign in
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
