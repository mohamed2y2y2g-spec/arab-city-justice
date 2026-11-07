const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "Arab City RP — Ministry Of Justice", stage: "setup-required" });
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "This endpoint is not enabled until authentication and server-side role checks are configured." }, 503);
    }
    return env.ASSETS.fetch(request);
  }
};
