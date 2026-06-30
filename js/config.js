// ================================================
// SALESPULSE — Environment Configuration
// ================================================
// In production, replace this file or inject via your build/deploy pipeline.
// The backend URL should NEVER contain a trailing slash.

window.ENV = {
  // When running locally without a backend, set to null to fallback to localStorage mode.
  // When deploying, set to your Azure/backend URL, e.g.: "https://SalesPulse-api.azurewebsites.net"
  API_BASE_URL: null,

  // Environment: "dev" | "prod"
  ENV: "dev",

  // App version
  VERSION: "2.0.0",
};
