import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { completeKlingLogin } from "@/lib/mcp-client";

export const Route = createFileRoute("/oauth/callback")({ component: Callback });

function Callback() {
  const [message, setMessage] = useState("正在完成可靈授權…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void completeKlingLogin().then((error) => {
      if (cancelled) return;
      if (error) {
        setFailed(true);
        setMessage(error);
        return;
      }
      setMessage("已連上可靈。回到片場那個分頁就可以了，這個分頁可以關掉。");
      window.close();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-md rounded-card border border-line bg-surface p-6 text-center">
        <p className="text-xs font-semibold tracking-widest text-brass">KLING MCP</p>
        <h1 className="mt-2 font-display text-3xl text-fg">可靈帳號</h1>
        <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
        {failed ? (
          <a href="/" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-brass px-4 text-sm font-semibold text-ink">
            回片場
          </a>
        ) : null}
      </section>
    </main>
  );
}
