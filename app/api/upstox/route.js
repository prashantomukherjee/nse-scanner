// Server-side proxy for Upstox API.
// Browser calls /api/upstox?url=ENCODED_UPSTOX_URL with Authorization header.
// This route forwards the call to Upstox and returns the response.
//
// Why this exists: Upstox API doesn't allow direct browser calls (no CORS).
// Putting the call server-side bypasses that.

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get("url");
  const auth   = request.headers.get("authorization");

  if (!target) {
    return Response.json({ error: "missing 'url' query param" }, { status: 400 });
  }
  if (!auth) {
    return Response.json({ error: "missing Authorization header" }, { status: 401 });
  }
  if (!target.startsWith("https://api.upstox.com/")) {
    return Response.json({ error: "url must be an api.upstox.com endpoint" }, { status: 400 });
  }

  try {
    const upstreamRes = await fetch(target, {
      headers: { "Accept": "application/json", "Authorization": auth },
    });
    const text = await upstreamRes.text();
    return new Response(text, {
      status: upstreamRes.status,
      headers: {
        "content-type": upstreamRes.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    return Response.json(
      { error: `upstream fetch failed: ${err.message}` },
      { status: 502 }
    );
  }
}
