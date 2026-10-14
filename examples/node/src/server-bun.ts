import { CLIENT_IP_HEADER, type Serve } from "./app.ts";

export const serveBun: Serve = async (handler, options) => {
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    fetch(request, srv) {
      const headers = new Headers(request.headers);
      headers.delete(CLIENT_IP_HEADER);
      const ip = srv.requestIP(request)?.address;
      if (ip) headers.set(CLIENT_IP_HEADER, ip);
      return handler(new Request(request, { headers }));
    },
  });
  return {
    async close() {
      await server.stop(true);
    },
  };
};
