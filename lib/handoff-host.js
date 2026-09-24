// src/handoff/host.ts
import { readFileSync } from "node:fs";

// src/handoff/protocol.ts
var HANDOFF_ROUTE_PREFIX = "/api/dsh-remote-handoff";
var MANAGE_PREFIX = "/manage";

// src/handoff/host.ts
var MANAGE_TIMEOUT_MS = 5e3;
var name = "dsh-remote-handoff";
var inject = ["connection"];
function apply(ctx) {
  ctx.inject(["connection"], (inner) => {
    const disposers = buildRoutes().map((route) => inner.connection.fetch.register({
      path: route.path,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: route.fetch
    }));
    inner.effect(() => () => {
      for (const dispose of disposers) void dispose();
    }, "dsh-remote-handoff.fetch-routes");
  });
}
function buildRoutes() {
  const via = async (op, request) => {
    const params = new URL(request.url).searchParams;
    const query = new URLSearchParams();
    const id = params.get("id");
    if (op !== "meta") {
      if (id === null || id === "") return json({ code: "bad_usage", message: "\u7F3A\u5C11 id \u53C2\u6570" }, 400);
      query.set("id", id);
    }
    if (op === "log") query.set("since", params.get("since") ?? "0");
    return callManage(op, query);
  };
  return [
    { path: `${HANDOFF_ROUTE_PREFIX}/meta`, fetch: async (req) => via("meta", req) },
    { path: `${HANDOFF_ROUTE_PREFIX}/state`, fetch: async (req) => via("state", req) },
    { path: `${HANDOFF_ROUTE_PREFIX}/log`, fetch: async (req) => via("log", req) }
  ];
}
async function callManage(op, query) {
  const materials = readMaterials();
  if (materials === void 0) {
    return json(
      { code: "handoff_unavailable", message: "\u4F1A\u8BDD\u8FD0\u884C\u65F6\u6750\u6599\u7F3A\u5931\uFF08\u53CD\u5411\u7AEF\u53E3/\u4EE3\u7406\u4EE4\u724C\u8BFB\u4E0D\u5230\uFF09" },
      503
    );
  }
  try {
    const upstream = await fetch(
      `http://127.0.0.1:${materials.reversePort}${MANAGE_PREFIX}/${op}?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${materials.proxyToken}` },
        signal: AbortSignal.timeout(MANAGE_TIMEOUT_MS)
      }
    );
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  } catch {
    return json(
      { code: "manager_unreachable", message: "\u672C\u673A\u7BA1\u7406\u901A\u9053\u4E0D\u53EF\u8FBE\uFF08\u672C\u5730 dsh \u53EF\u80FD\u5DF2\u9000\u51FA\uFF09" },
      502
    );
  }
}
function readMaterials() {
  const home = process.env.DSH_HOME;
  if (home === void 0 || home === "") return void 0;
  try {
    const port = Number.parseInt(readFileSync(`${home}/.runtime/reverse-port`, "utf8").trim(), 10);
    const token = readFileSync(`${home}/.runtime/proxy-token`, "utf8").trim();
    if (!Number.isFinite(port) || port <= 0 || token === "") return void 0;
    return { reversePort: port, proxyToken: token };
  } catch {
    return void 0;
  }
}
function json(body, status) {
  return Response.json(body, { status });
}
export {
  apply,
  inject,
  name
};
