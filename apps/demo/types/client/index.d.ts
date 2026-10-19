// The browser modules import "../client/index.js", the copy of the client in
// the assets. tsconfig.browser.json joins this folder to src by rootDirs, so
// tsc reads the declarations of the client build for that URL.
export * from "../../../../packages/client/dist/index.js";
