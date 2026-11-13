// Page configuration. Services themselves are defined in exporter/config.json on the server;
// the page renders whatever the exporter publishes.
window.STATUS_CONFIG = {
  liveUrl: "https://binokel.tail108204.ts.net/status/status.json",
  // history store (orphan `data` branch, written by .github/workflows/collect.yml)
  historyBase: "https://raw.githubusercontent.com/AscendancyDotA/status/data/",
  // owner-only numbers (exporter `private`): requested only when this browser holds the owner key
  privateUrl: "https://binokel.tail108204.ts.net/status/private.json",
  privateRefreshMs: 120000,
  refreshMs: 30000,
  historyRefreshMs: 300000,
};
