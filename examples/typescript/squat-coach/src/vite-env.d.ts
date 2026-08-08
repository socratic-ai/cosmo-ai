/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COSMO_API_KEY?: string;
  readonly VITE_COSMO_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
