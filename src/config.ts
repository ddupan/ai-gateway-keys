// Every deployment-specific value comes from the environment; defaults are the homelab's.
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  port: Number(env("PORT", "8080")),
  publicUrl: env("PUBLIC_URL"),
  sessionSecret: env("SESSION_SECRET"),
  sessionHours: Number(env("SESSION_HOURS", "8")),
  oidc: {
    issuer: env("OIDC_ISSUER", "https://sso.ddupan.top"),
    clientId: env("OIDC_CLIENT_ID"),
    clientSecret: env("OIDC_CLIENT_SECRET"),
    scopes: env("OIDC_SCOPES", "openid profile groups"),
  },
  // Members of any of these groups may manage keys (comma-separated).
  allowedGroups: env("ALLOWED_GROUPS", "platform-admins").split(",").map((s) => s.trim()).filter(Boolean),
  bao: {
    addr: env("BAO_ADDR", "https://bao.lab.ddupan.top:8200"),
    authPath: env("BAO_AUTH_PATH", "kubernetes"),
    role: env("BAO_ROLE", "ai-gateway-keys"),
    jwtFile: env("BAO_JWT_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
    mount: env("BAO_KV_MOUNT", "kv"),
    prefix: env("BAO_KV_PREFIX", "k8s/ai-gateway-keys"),
  },
  vmUrl: env("VM_URL", "http://vmsingle-main.monitoring.svc:8428"),
  // Shown to users so they know where to point their clients.
  gatewayUrl: env("GATEWAY_URL", "https://ai.lab.ddupan.top"),
  // Optional: ExternalSecret to nudge after a change so it takes effect at once.
  sync: process.env.SYNC_EXTERNALSECRET
    ? { namespace: env("SYNC_NAMESPACE", "ai-gateway"), name: process.env.SYNC_EXTERNALSECRET }
    : undefined,
};
