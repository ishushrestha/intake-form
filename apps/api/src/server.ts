import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpStaticServer } from "effect/http";
import { IpNetwork } from "effect/net";
import { DEFAULT_HOST, type AppConfig } from "./config.js";
import { makeRoutes } from "./http.js";

const LOOPBACK_PROXIES = [
  IpNetwork.fromStringUnsafe("127.0.0.0/8"),
  IpNetwork.fromStringUnsafe("::1/128"),
];

function listen(config: AppConfig) {
  return NodeHttpServer.layer(() => createServer(), {
    host: config.host ?? DEFAULT_HOST,
    port: config.port,
  });
}

function appRoutes(config: AppConfig) {
  if (config.webDistDir === undefined) {
    return makeRoutes(config);
  }
  return Layer.mergeAll(
    makeRoutes(config),
    HttpStaticServer.layer({ root: config.webDistDir, spa: true, index: "index.html" }),
  );
}

export const makeServer = (config: AppConfig) => {
  const routes = appRoutes(config);
  if (config.trustProxy === true) {
    return HttpRouter.serve(routes, {
      middleware: HttpMiddleware.xForwardedHeaders({ trustedProxies: LOOPBACK_PROXIES }),
    }).pipe(Layer.provide(listen(config)));
  }
  return HttpRouter.serve(routes).pipe(Layer.provide(listen(config)));
};

export const makeHandler = (config: AppConfig) =>
  HttpRouter.toWebHandler(makeRoutes(config), { disableLogger: true });
