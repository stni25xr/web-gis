export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    };
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }
    try {
      const body = await request.json();
      const model = body.model || "gpt2";
      const inputs = body.inputs || "";
      const hfRes = await fetch(`https://api-inference.huggingface.co/models/${model}?wait_for_model=true`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ inputs })
      });
      const data = await hfRes.text();
      return new Response(data, {
        status: hfRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Proxy error" }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};
