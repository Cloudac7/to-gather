/// <reference types="astro/client" />

declare interface Env {
  DB: D1Database;
  AVATARS: R2Bucket;
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUTH_PEPPER: string;
  APP_ENV?: string;
}
