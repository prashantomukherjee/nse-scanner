import { NextResponse } from "next/server";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const { password } = body;
  const expected = process.env.APP_PASSWORD;

  if (!expected) {
    return NextResponse.json(
      { error: "server misconfigured: APP_PASSWORD not set" },
      { status: 500 }
    );
  }

  if (password !== expected) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  // Set HttpOnly cookie — not accessible to JavaScript
  const res = NextResponse.json({ success: true });
  res.cookies.set("nse_session", expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ success: true });
  res.cookies.delete("nse_session");
  return res;
}
