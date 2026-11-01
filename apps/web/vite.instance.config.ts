// Local-only (git-excluded): run this checkout's dev server on its own ports so
// several builds can run side by side. Env: JB_WEB_PORT, JB_API_PORT.
import base from "./vite.config";

const api = process.env.JB_API_PORT ?? "3001";
const retarget = (v: unknown) =>
  typeof v === "string"
    ? v.replace(":3001", `:${api}`)
    : {
        ...(v as { target: string }),
        target: (v as { target: string }).target.replace(":3001", `:${api}`),
      };

export default {
  ...base,
  server: {
    ...base.server,
    host: true,
    port: Number(process.env.JB_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: Object.fromEntries(
      Object.entries(base.server?.proxy ?? {}).map(([k, v]) => [k, retarget(v)]),
    ),
  },
};
