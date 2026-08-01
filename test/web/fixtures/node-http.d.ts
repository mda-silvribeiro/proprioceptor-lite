// tsconfig.web.json sets `"types": []` deliberately: the browser-facing code in
// web/ must not be able to reach Node globals, and nothing here should either.
// The static-file fixture does need a handful of Node symbols, so they are
// declared narrowly — only the members the fixture actually calls, structurally
// compatible with the real ones.
//
// If `@types/node` is ever added to the `types` array of tsconfig.web.json,
// delete this file: the real declarations would then collide with these.

declare module "node:http" {
  export interface FixtureRequest {
    readonly url?: string | undefined;
    readonly method?: string | undefined;
  }

  export interface FixtureResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string | Uint8Array): void;
  }

  export interface FixtureServer {
    listen(port: number, host: string, listener: () => void): void;
    close(callback: (error?: unknown) => void): void;
    address(): { readonly port: number } | string | null;
  }

  export function createServer(
    handler: (request: FixtureRequest, response: FixtureResponse) => void,
  ): FixtureServer;
}

declare module "node:fs" {
  /** Returns a Buffer, which is a Uint8Array — all the fixture needs. */
  export function readFileSync(path: string): Uint8Array;
}
