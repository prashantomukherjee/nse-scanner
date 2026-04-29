"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error || "login failed");
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "calc(100vh - 3rem)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--font-mono)",
    }}>
      <form onSubmit={handleSubmit} style={{
        width: "100%", maxWidth: "360px",
        background: "var(--color-background-secondary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-lg)",
        padding: "24px",
      }}>
        <div style={{
          fontSize: "10px", letterSpacing: "0.12em",
          color: "var(--color-text-tertiary)", textTransform: "uppercase",
        }}>
          National Stock Exchange · India
        </div>
        <div style={{
          fontSize: "18px", fontWeight: 500,
          color: "var(--color-text-primary)", marginTop: "2px", marginBottom: "20px",
        }}>
          Options scanner
        </div>

        <label style={{
          display: "block", fontSize: "11px",
          color: "var(--color-text-secondary)", marginBottom: "6px",
        }}>
          password
        </label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoFocus
          required
          style={{
            width: "100%", padding: "8px 10px",
            fontSize: "13px", fontFamily: "var(--font-mono)",
            background: "var(--color-background-primary)",
            border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)",
            marginBottom: "12px",
          }}
        />

        {error && (
          <div style={{
            padding: "8px 10px",
            background: "var(--color-background-danger)",
            color: "var(--color-text-danger)",
            borderRadius: "var(--border-radius-md)",
            fontSize: "11px", marginBottom: "10px",
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            width: "100%", padding: "8px 12px",
            fontSize: "13px",
            cursor: (loading || !password) ? "not-allowed" : "pointer",
            opacity: (loading || !password) ? 0.6 : 1,
          }}
        >
          {loading ? "checking..." : "sign in →"}
        </button>
      </form>
    </div>
  );
}
