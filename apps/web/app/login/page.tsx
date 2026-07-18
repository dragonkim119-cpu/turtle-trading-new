"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push("/chart");
      router.refresh();
    } else {
      setError("비밀번호가 틀립니다");
    }
  };

  return (
    <div className="card" style={{ marginTop: 80 }}>
      <h2>🐢 Turtle Trading</h2>
      <form onSubmit={submit}>
        <label>비밀번호</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <p style={{ color: "var(--red)", marginTop: 8 }}>{error}</p>}
        <button style={{ marginTop: 12, width: "100%" }}>로그인</button>
      </form>
    </div>
  );
}
