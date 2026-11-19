(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UmeDebugEmail = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_MAX_LOG_LENGTH = 16_000;

  function buildDebugEmail(log, options = {}) {
    const recipient = options.recipient || "justin.garcia@gmail.com";
    const version = options.version || "unknown";
    const platform = options.platform || "unknown";
    const maxLogLength = Number.isFinite(options.maxLogLength) && options.maxLogLength > 0
      ? Math.floor(options.maxLogLength)
      : DEFAULT_MAX_LOG_LENGTH;
    const fullLog = String(log || "No extension debug entries yet.");
    const truncated = fullLog.length > maxLogLength;
    const includedLog = truncated ? fullLog.slice(-maxLogLength) : fullLog;
    const body = [
      "Hi Justin,",
      "",
      "I'm sending Umete extension debug logs for review.",
      `Umete version: ${version}`,
      `Platform: ${platform}`,
      ...(truncated ? ["", `The log exceeded the email limit. The most recent ${maxLogLength.toLocaleString("en-US")} characters are included; use Copy in Umete for the complete log.`] : []),
      "",
      "--- Umete Debug Logs ---",
      includedLog
    ].join("\r\n");
    return `mailto:${recipient}?subject=${encodeURIComponent("Umete debug logs")}&body=${encodeURIComponent(body)}`;
  }

  // The version and platform lines, from the app's answer to UME_GET_APP_INFO.
  // manifest.json's version is never stamped (it stays 0.1.0), so without the app
  // the version is unknown, and Safari's own "ios" or "mac" stands in for the platform.
  function reportSource(appInfo, safariOS) {
    if (appInfo?.ok && appInfo.version) {
      const version = appInfo.build ? `${appInfo.version} (${appInfo.build})` : appInfo.version;
      const platform = [appInfo.platform, appInfo.model && `(${appInfo.model})`].filter(Boolean).join(" ");
      return { version, platform: platform || safariOS || "unknown" };
    }
    return { version: "unknown", platform: safariOS || "unknown" };
  }

  return { buildDebugEmail, reportSource, DEFAULT_MAX_LOG_LENGTH };
});
