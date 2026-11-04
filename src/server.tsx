import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { FC, PropsWithChildren } from "hono/jsx";
import * as oidc from "openid-client";
import { createKey, getKey, listKeys, revokeKey, type KeyRecord } from "./bao.js";
import { config } from "./config.js";
import { inGroups, newKey, originAllowed, validId } from "./keys.js";
import { nudge } from "./sync.js";
import { usage, type Usage } from "./usage.js";

type User = { name: string; exp: number };
const SESSION = "aigw_session";
const LOGIN = "aigw_login";
const redirectUri = new URL("/callback", config.publicUrl).href;
const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };

let oidcConfig: oidc.Configuration | undefined;
async function oidcClient(): Promise<oidc.Configuration> {
  // Discovered lazily and retried on the next request if iam-login was down at startup.
  oidcConfig ??= await oidc.discovery(
    new URL(config.oidc.issuer),
    config.oidc.clientId,
    undefined,
    oidc.ClientSecretBasic(config.oidc.clientSecret),
  );
  return oidcConfig;
}

async function currentUser(c: Context): Promise<User | undefined> {
  const raw = await getSignedCookie(c, config.sessionSecret, SESSION);
  if (!raw) return undefined;
  const u = JSON.parse(raw) as User;
  return u.exp > Date.now() ? u : undefined;
}

const app = new Hono<{ Variables: { user: User } }>();

app.get("/healthz", (c) => c.text("ok"));

app.get("/login", async (c) => {
  const cfg = await oidcClient();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  await setSignedCookie(c, LOGIN, JSON.stringify({ verifier, state, nonce }), config.sessionSecret, {
    ...cookieOpts,
    maxAge: 600,
  });
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri,
    scope: config.oidc.scopes,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return c.redirect(url.href);
});

app.get("/callback", async (c) => {
  const raw = await getSignedCookie(c, config.sessionSecret, LOGIN);
  if (!raw) return c.redirect("/login");
  deleteCookie(c, LOGIN, { path: "/" });
  const { verifier, state, nonce } = JSON.parse(raw);
  const cfg = await oidcClient();
  const tokens = await oidc.authorizationCodeGrant(cfg, new URL(c.req.url.replace(/^http:/, "https:")), {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims()!;
  let groups = claims.groups;
  if (groups === undefined) {
    groups = (await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub)).groups;
  }
  const name = String(claims.preferred_username ?? claims.name ?? claims.sub);
  if (!inGroups(groups, config.allowedGroups)) {
    return c.html(<Page title="无权访问"><p>{name} 没有管理 API Key 的权限。</p></Page>, 403);
  }
  const user: User = { name, exp: Date.now() + config.sessionHours * 3600_000 };
  await setSignedCookie(c, SESSION, JSON.stringify(user), config.sessionSecret, cookieOpts);
  return c.redirect("/");
});

app.post("/logout", (c) => {
  deleteCookie(c, SESSION, { path: "/" });
  return c.redirect("/login");
});

// Everything below needs a session; state-changing requests must also come from our own pages.
app.use("*", async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/login");
  if (c.req.method !== "GET" && !originAllowed(c.req.header("origin"), config.publicUrl)) {
    return c.text("forbidden", 403);
  }
  c.set("user", user);
  await next();
});

app.get("/", async (c) => {
  const [keys, use] = await Promise.all([
    listKeys(),
    usage().catch((e) => {
      console.warn(`usage: ${e}`);
      return undefined;
    }),
  ]);
  keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.html(<KeyList user={c.get("user")} keys={keys} usage={use} />);
});

app.post("/keys", async (c) => {
  const form = await c.req.parseBody();
  const id = String(form.id ?? "").trim();
  const description = String(form.description ?? "").trim().slice(0, 200);
  if (!validId(id)) return c.html(<Page title="创建失败"><p>名称只能用小写字母、数字和连字符，最长 40 个字符。</p><a href="/">返回</a></Page>, 400);
  const key = newKey();
  if (!(await createKey(id, key, description, c.get("user").name))) {
    return c.html(<Page title="创建失败"><p>名称 {id} 已存在，请换一个。</p><a href="/">返回</a></Page>, 409);
  }
  console.log(JSON.stringify({ audit: "key.create", id, by: c.get("user").name }));
  await nudge();
  c.header("cache-control", "no-store");
  return c.html(<Created id={id} apiKey={key} />);
});

app.post("/keys/:id/revoke", async (c) => {
  const id = c.req.param("id");
  if (validId(id) && (await getKey(id))) {
    await revokeKey(id);
    console.log(JSON.stringify({ audit: "key.revoke", id, by: c.get("user").name }));
    await nudge();
  }
  return c.redirect("/");
});

// ---- views ---------------------------------------------------------------

const fmt = (d?: string | Date) =>
  d ? new Date(d).toLocaleString("zh-CN", { timeZone: process.env.TZ ?? "Asia/Tokyo", hour12: false }) : "—";

const Page: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · AI 网关</title>
      <style>{`
        body{font:15px/1.5 system-ui,sans-serif;max-width:64rem;margin:2rem auto;padding:0 1rem;color:#222}
        table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd}
input{padding:.3rem}button{padding:.3rem .8rem;cursor:pointer}
        code{background:#f3f3f3;padding:.1rem .3rem;word-break:break-all}.key{font-size:1.1em;padding:.6rem;display:block}
        header{display:flex;justify-content:space-between;align-items:center}
        @media (prefers-color-scheme:dark){body{background:#181818;color:#ddd}code{background:#2a2a2a}th,td{border-color:#333}}
      `}</style>
    </head>
    <body>{children}</body>
  </html>
);

const KeyList: FC<{ user: User; keys: KeyRecord[]; usage?: Map<string, Usage> }> = ({ user, keys, usage }) => (
  <Page title="API Key">
    <header>
      <h1>AI 网关 API Key</h1>
      <form method="post" action="/logout">{user.name} <button>退出</button></form>
    </header>
    <p>
      地址 <code>{config.gatewayUrl}</code>。Claude 客户端用 <code>{config.gatewayUrl}/anthropic</code>，
      OpenAI 兼容客户端用 <code>{config.gatewayUrl}/v1</code>；Key 放在请求头 <code>x-api-key</code>。
    </p>
    <h2>新建</h2>
    <form method="post" action="/keys">
      <input name="id" placeholder="名称，如 research-auto" required pattern="[a-z0-9-]{1,40}" />{" "}
      <input name="description" placeholder="用途" size={40} /> <button>创建</button>
    </form>
    <h2>全部 Key</h2>
    {usage === undefined && <p>用量数据暂时取不到，稍后刷新。</p>}
    <table>
      <thead>
        <tr><th>名称</th><th>用途</th><th>创建</th><th>最后使用</th><th>30 天请求</th><th>30 天 token</th><th></th></tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const u = usage?.get(k.id);
          return (
            <tr>
              <td>{k.id}</td>
              <td>{k.description}</td>
              <td>{fmt(k.createdAt)}<br /><small>{k.createdBy}</small></td>
              <td>{u?.lastUsed ? fmt(u.lastUsed) : "从未"}</td>
              <td>{u?.requests30d ?? 0}</td>
              <td>{u?.tokens30d ?? 0}</td>
              <td>
                {k.status === "incomplete" && <small>未完成，未生效 </small>}
                  <form method="post" action={`/keys/${k.id}/revoke`} onsubmit={`return confirm('吊销 ${k.id}？使用它的客户端会立即失效。')`}>
                    <button>吊销</button>
                  </form>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </Page>
);

const Created: FC<{ id: string; apiKey: string }> = ({ id, apiKey }) => (
  <Page title="已创建">
    <h1>{id} 已创建</h1>
    <p>这个 Key 只显示这一次，请现在复制保存：</p>
    <code class="key">{apiKey}</code>
    <p>大约一分钟内生效。</p>
    <a href="/">返回列表</a>
  </Page>
);

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`listening on :${i.port}`));
