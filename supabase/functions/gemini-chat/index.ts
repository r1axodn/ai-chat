// AI 공용방 — Gemini 프록시 Edge Function
//
// 배포:
//   supabase functions deploy gemini-chat --project-ref <프로젝트ref>
//   supabase secrets set GEMINI_API_KEY=AIza... --project-ref <프로젝트ref>
//
// 이 함수의 존재 이유는 하나입니다. Gemini API 키가 브라우저로 절대 나가지 않게 하는 것.
// 앱(정적 페이지)은 이 엔드포인트만 호출하고, 키는 Supabase 환경변수에만 있습니다.

// deno-lint-ignore-file no-explicit-any

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";

const ALLOWED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PROMPT_CHARS = 8000;
const MAX_SYSTEM_CHARS = 1200;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_LIMIT;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) {
    return json({ error: "too_many_requests" }, 429);
  }

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    // 키가 없으면 프론트엔드는 데모 응답으로 물러난다
    return json({ error: "server_key_missing" }, 503);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const model = ALLOWED_MODELS.has(payload?.model) ? payload.model : "gemini-2.5-flash";
  const system = clampText(payload?.system, MAX_SYSTEM_CHARS);
  const prompt = clampText(payload?.prompt, MAX_PROMPT_CHARS);
  if (!prompt.trim()) return json({ error: "empty_prompt" }, 400);

  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: typeof payload?.temperature === "number"
        ? Math.min(1.5, Math.max(0, payload.temperature))
        : 0.9,
      maxOutputTokens: 220,
      topP: 0.95,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };

  try {
    const res = await fetch(`${GEMINI_ENDPOINT}${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text();
      // 키나 내부 사정은 그대로 흘리지 않는다
      console.error("gemini_error", res.status, detail.slice(0, 400));
      return json({ error: res.status === 429 ? "quota_exceeded" : "gemini_failed" }, 502);
    }

    const data = await res.json();
    const text: string =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";

    if (!text.trim()) return json({ error: "empty_response" }, 502);

    return json({ text: text.trim().slice(0, 600), model });
  } catch (err) {
    console.error("gemini_request_failed", String(err).slice(0, 300));
    return json({ error: "upstream_unreachable" }, 502);
  }
});
