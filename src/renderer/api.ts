import type { RcppApi } from '../preload';

declare global {
  interface Window {
    rcpp: RcppApi;
  }
}

export const rcpp: RcppApi = window.rcpp;
