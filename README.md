# ai-gateway-keys

Web UI for the homelab AI gateway's API keys: create, revoke, and see when each key was
created, by whom, when it was last used and how much it used.

- Login: OIDC against iam-login (`sso.ddupan.top`); only members of `ALLOWED_GROUPS` get in.
- Storage: OpenBao KV v2, one secret per key at `kv/k8s/ai-gateway-keys/<id>` (field `key`).
  `custom_metadata` holds `status`, `created_by`, `description`; Bao's own metadata provides the
  creation time. Revoking deletes the secret entirely. Every create/revoke is logged as a JSON
  line `{"audit":"key.create|key.revoke","id":…,"by":…}` (and Bao's audit log has it too).
- The gateway reads only `status=active` keys (an ExternalSecret that finds by tag); after a
  change the app annotates that ExternalSecret so ESO syncs at once.
- Usage: VictoriaMetrics, from Agent Router's `gen_ai_*` metrics labelled `ai_gateway_client`.

Configuration is all environment variables, see `src/config.ts`. Deployment lives in
homelab-infra `apps/ai-gateway/`.

```bash
npm ci && npm test
```
