// Type fixture (plan 11d2): the binding against the types of
// @tanstack/react-start 1.169.1 and @tanstack/solid-start 1.169.1.
// `typecheck` fails when either changes a shape that the binding fits today.
import type { Auth } from "@authtempo/core";
import {
  createMiddleware as reactMiddleware,
  createStart as reactStart,
} from "@tanstack/react-start";
import {
  createMiddleware as solidMiddleware,
  createStart as solidStart,
} from "@tanstack/solid-start";
import { authRequestServer } from "../src/index.js";

declare const auth: Auth;

const reactAuth = reactMiddleware({ type: "request" }).server(authRequestServer({ auth }));
export const reactInstance = reactStart(() => ({ requestMiddleware: [reactAuth] }));

const solidAuth = solidMiddleware({ type: "request" }).server(authRequestServer({ auth }));
export const solidInstance = solidStart(() => ({ requestMiddleware: [solidAuth] }));
